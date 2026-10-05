import asyncio
import ast
import copy
import hashlib
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("namzu_blender_bridge", sys.argv.pop(1))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
# Optional source-level reproducer, with no installed Python dependencies:
# python3 blender-bridge-test.py /absolute/pal-blender-mcp.py /absolute/pinned-upstream-root
pinned_root = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else None


class Connection:
    def __init__(self, response=None, send_error=None):
        self.response = response
        self.send_error = send_error
        self.sent = []
        self.sock = self
        self.disconnects = 0

    def connect(self):
        return False

    def sendall(self, data):
        self.sent.append(data)
        if self.send_error:
            raise self.send_error

    def settimeout(self, timeout):
        self.timeout = timeout

    def receive_full_response(self, _sock):
        if isinstance(self.response, BaseException):
            raise self.response
        return self.response

    def disconnect(self):
        self.disconnects += 1
        self.sock = None


class CopyModel:
    def model_copy(self, update):
        result = copy.copy(self)
        result.__dict__.update(update)
        return result


class ToolResult(CopyModel):
    def __init__(self):
        self.meta = {"retained": True}
        self.isError = False
        self.content = [SimpleNamespace(type="image", data="retained-image")]


class ServerResult(CopyModel):
    def __init__(self, root):
        self.root = root


types = SimpleNamespace(ServerResult=ServerResult, CallToolResult=ToolResult, TextContent=SimpleNamespace)


class BridgeTests(unittest.TestCase):
    def test_disabled_collector_bypasses_constructor_but_preserves_consent_reader(self):
        class Collector:
            def __init__(self):
                raise AssertionError("Must not import private config, start workers or persist a UUID")

            def _is_disabled(self):
                return True

            def check_user_consent(self):
                return connection.consent

        connection = SimpleNamespace(consent=True)
        module = SimpleNamespace(TelemetryCollector=Collector, _telemetry_collector=None)
        # References imported before startup must still observe the singleton.
        get_telemetry = lambda: module._telemetry_collector
        bridge.install_disabled_telemetry(module)
        collector = get_telemetry()
        self.assertIsInstance(collector, Collector)
        self.assertFalse(collector.config.enabled)
        self.assertEqual(vars(collector.config), {"enabled": False})
        self.assertTrue(collector.check_user_consent())
        connection.consent = False
        self.assertFalse(collector.check_user_consent())
        self.assertFalse(hasattr(collector, "_queue"))
        self.assertFalse(hasattr(collector, "_customer_uuid"))

    def test_non_disabled_collector_is_untouched(self):
        class Collector:
            def __init__(self):
                raise AssertionError("The shim does not construct upstream telemetry")

            def _is_disabled(self):
                return False

        original = object()
        module = SimpleNamespace(TelemetryCollector=Collector, _telemetry_collector=original)
        bridge.install_disabled_telemetry(module)
        self.assertIs(module._telemetry_collector, original)

    @unittest.skipUnless(pinned_root, "Pass the reviewed source root to run the upstream regression reproducer")
    def test_pinned_upstream_disabled_status_without_private_config(self):
        source = pinned_root / "src" / "blender_mcp"
        self.assertEqual(hashlib.sha256((source / "telemetry.py").read_bytes()).hexdigest(), bridge.TELEMETRY_SHA256)
        self.assertEqual(hashlib.sha256((source / "server.py").read_bytes()).hexdigest(), bridge.SERVER_SHA256)
        self.assertFalse((source / "config.py").exists())
        package = ModuleType("blender_mcp")
        package.__path__ = [str(source)]
        server = ModuleType("blender_mcp.server")
        httpx = SimpleNamespace(post=Mock(side_effect=AssertionError("Disabled telemetry must not upload")))
        telemetry_spec = importlib.util.spec_from_file_location("blender_mcp.telemetry", source / "telemetry.py")
        telemetry = importlib.util.module_from_spec(telemetry_spec)
        consent = False
        commands = []

        class Addon:
            def send_command(self, command):
                commands.append(command)
                if command != "get_telemetry_consent":
                    raise AssertionError(f"Unexpected addon command {command}")
                return {"consent": consent}

        async def no_consent_prompt(_ctx):
            return ""

        modules = {"blender_mcp": package, "blender_mcp.telemetry": telemetry, "blender_mcp.server": server, "httpx": httpx}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"BLENDER_MCP_DISABLE_TELEMETRY": "1"}, clear=True):
            telemetry_spec.loader.exec_module(telemetry)
            server.__dict__.update({
                "Context": SimpleNamespace,
                "json": json,
                "get_telemetry": telemetry.get_telemetry,
                "get_blender_connection": lambda: Addon(),
                "_addon_handshake_lock": bridge.threading.Lock(),
                "_addon_handshake": SimpleNamespace(up_to_date=True, protocol_version=1, addon_version="2.1.7", capabilities=["look"], blender_version="5.2.2", premium_generators=[], source="addon", warning=None),
                "EXPECTED_ADDON_PROTOCOL_VERSION": 1,
                "_maybe_handshake_addon": lambda _blender: None,
                "_integrations": lambda _blender, _premium: {},
                "premium_generation_guidance": lambda _premium: "",
                "maybe_prompt_for_consent": no_consent_prompt,
            })
            # Execute the actual pinned status handler, not a copied approximation.
            tree = ast.parse((source / "server.py").read_text())
            status = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "get_addon_status")
            status.decorator_list = []
            exec(compile(ast.Module(body=[status], type_ignores=[]), "pinned_get_addon_status", "exec"), server.__dict__)
            before = asyncio.run(server.get_addon_status(None))
            self.assertEqual(before, "Error checking addon status: No module named 'blender_mcp.config'")
            with patch.object(telemetry.TelemetryCollector, "_get_or_create_uuid", side_effect=AssertionError("No persistent UUID")), patch.object(bridge.threading.Thread, "start", side_effect=AssertionError("No telemetry worker")):
                bridge.install_disabled_telemetry(telemetry)
                result = json.loads(asyncio.run(server.get_addon_status(None)))
                self.assertEqual(result["blender_version"], "5.2.2")
                self.assertEqual(result["addon_version"], "2.1.7")
                self.assertIs(result["telemetry_consent"], False)
                consent = True
                telemetry.get_telemetry().invalidate_consent_cache()
                # A checked addon box is reported truthfully while explicit disable
                # still blocks all actual event and screenshot collection.
                result = json.loads(asyncio.run(server.get_addon_status(None)))
                self.assertIs(result["telemetry_consent"], True)
                telemetry.record_startup("5.2.2")
                telemetry.record_tool_usage("look", True, 0)
                self.assertEqual(telemetry.get_telemetry().upload_screenshot(b"image", "test"), "")
                self.assertFalse(telemetry.is_telemetry_enabled())
                self.assertEqual(commands, ["get_telemetry_consent", "get_telemetry_consent"])
                httpx.post.assert_not_called()

    def test_positive_reply_and_confirmed_addon_error_settle(self):
        guard = bridge.BlenderOutcomeGuard()
        connection = Connection(b'{"status":"success","result":{"value":1}}')
        self.assertEqual(guard.send_locked(connection, "execute_code", {"code": "x"}), {"value": 1})
        self.assertEqual(json.loads(connection.sent[0]), {"type": "execute_code", "params": {"code": "x"}})
        connection.response = b'{"status":"error","message":"Python raised after its mutation"}'
        with self.assertRaisesRegex(RuntimeError, "Python raised"):
            guard.send_locked(connection, "execute_code")
        self.assertFalse(guard.unknown.is_set())
        self.assertEqual(connection.disconnects, 0)

    def test_preconnect_refusal_does_not_claim_delivery(self):
        guard = bridge.BlenderOutcomeGuard()
        connection = Connection()
        connection.sock = None
        with self.assertRaises(ConnectionError):
            guard.send_locked(connection, "execute_code")
        self.assertFalse(guard.unknown.is_set())
        self.assertEqual(connection.sent, [])

    def test_partial_send_timeout_eof_invalid_reply_are_sticky_unknown(self):
        for response, send_error in (
            (b'', BrokenPipeError("sendall partially delivered")),
            (TimeoutError("socket deadline"), None),
            (RuntimeError("No data received"), None),
            (RuntimeError("Incomplete JSON response received"), None),
            (b'{"status":', None),
            (b'[]', None),
            (b'{"status":"pending"}', None),
        ):
            with self.subTest(response=response, send_error=send_error):
                guard = bridge.BlenderOutcomeGuard()
                connection = Connection(response, send_error)
                with self.assertRaises(BaseException):
                    guard.send_locked(connection, "execute_code")
                self.assertTrue(guard.unknown.is_set())
                self.assertEqual(connection.disconnects, 1)
                connection.sock = connection
                connection.response = b'{"status":"success","result":{}}'
                connection.send_error = None
                with self.assertRaisesRegex(RuntimeError, "outcome is unknown"):
                    guard.send_locked(connection, "execute_code")
                self.assertEqual(len(connection.sent), 1)

    def test_handler_marks_normal_success_text_unknown_and_retains_images(self):
        async def run():
            connection = Connection(RuntimeError("No data received"))
            class BlenderConnection(Connection):
                pass
            original_result = ServerResult(ToolResult())
            async def upstream_handler(_request):
                try:
                    BlenderConnection._send_command_locked(connection, "execute_code")
                except Exception:
                    # Upstream's normal MCP text response catches the bridge error.
                    pass
                return original_result
            lowlevel = SimpleNamespace(request_handlers={"call": upstream_handler}, lifespan=None)
            server = SimpleNamespace(BlenderConnection=BlenderConnection, mcp=SimpleNamespace(_mcp_server=lowlevel))
            guard = bridge.install_guard(server, types)
            result = await lowlevel.request_handlers["call"](None)
            self.assertTrue(guard.unknown.is_set())
            self.assertTrue(result.root.isError)
            self.assertEqual(result.root.meta, {"retained": True, "namzu/outcome": "unknown"})
            self.assertEqual(result.root.content[0].data, "retained-image")
            self.assertFalse(original_result.root.isError)
            self.assertNotIn("namzu/outcome", original_result.root.meta)
            async with lowlevel.lifespan(None) as context:
                self.assertEqual(context, {})
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
