#!/usr/bin/env python3
"""Owned guest entry point for mcp-for-blender 2.1.7 at the documented source pin.

The addon runs in a separate Blender process. Killing the MCP server cannot
cancel a command already delivered to it. Preserve that distinction before
upstream tool decorators turn transport exceptions into ordinary text replies.
"""

import hashlib
import json
import threading
from contextlib import asynccontextmanager
from importlib import metadata, util
from pathlib import Path
from types import SimpleNamespace

SERVER_SHA256 = "646ae0ead84cd854c584d07880006d3871e91294d23b1ebb2078f3d07f87dd9e"
TELEMETRY_SHA256 = "fd65b30cbf053cb870f96e6af054b517e28fa6c594230a768cb2ff67f6a011ea"


def install_disabled_telemetry(telemetry):
    # The pinned collector imports an unpublished backend config before checking
    # its explicit disable flags. Allocate only its readonly consent state here;
    # no backend credentials, persistent UUID, queue or uploader worker are needed.
    collector = telemetry.TelemetryCollector.__new__(telemetry.TelemetryCollector)
    if not collector._is_disabled():
        return
    collector.config = SimpleNamespace(enabled=False)
    collector._consent_cache = None
    collector._consent_cached_at = 0.0
    collector._consent_lock = threading.Lock()
    # Existing get_telemetry imports share this singleton. Pinned event/upload
    # methods and trajectory writers return before any collection when disabled;
    # check_user_consent still reports the actual addon checkbox, not a guess.
    telemetry._telemetry_collector = collector


class BlenderOutcomeGuard:
    def __init__(self):
        self.unknown = threading.Event()

    def send_locked(self, connection, command_type, params=None):
        if self.unknown.is_set():
            raise RuntimeError("The Blender command outcome is unknown; restart this computer before further work.")
        if not connection.sock and not connection.connect():
            raise ConnectionError("Not connected to Blender")
        command = json.dumps({"type": command_type, "params": params or {}}).encode("utf-8")
        issued = False
        confirmed = False
        try:
            # A failed sendall can have delivered a prefix or the complete command.
            issued = True
            connection.sock.sendall(command)
            connection.sock.settimeout(180.0)
            response = json.loads(connection.receive_full_response(connection.sock).decode("utf-8"))
            # The pinned protocol correlates replies by ordering under send_command's
            # single connection lock. Unknown/malformed statuses do not confirm it.
            if not isinstance(response, dict) or response.get("status") not in ("success", "error"):
                raise ValueError("The Blender addon returned an invalid command response")
            confirmed = True
            if response["status"] == "error":
                raise RuntimeError(response.get("message", "Unknown error from Blender"))
            return response.get("result", {})
        except BaseException:
            if issued and not confirmed:
                self.unknown.set()
            # Never reuse a possibly desynchronized ordered reply stream.
            if self.unknown.is_set():
                connection.disconnect()
            raise

    def annotate(self, result, types):
        if not isinstance(result, types.ServerResult):
            raise RuntimeError("Unsupported MCP result shape; the Blender outcome remains unknown")
        payload = result.root
        unknown = self.unknown.is_set()
        update = {"meta": {**(payload.meta or {}), "namzu/outcome": "unknown" if unknown else "settled"}}
        if unknown and isinstance(payload, types.CallToolResult):
            update["isError"] = True
            update["content"] = [*payload.content, types.TextContent(
                type="text",
                text="Blender did not confirm command completion. Do not retry or take over; stop and restart this computer before further work.",
            )]
        return result.model_copy(update={"root": payload.model_copy(update=update)})


def install_guard(server, types):
    guard = BlenderOutcomeGuard()
    def send_locked(connection, command_type, params=None):
        return guard.send_locked(connection, command_type, params)
    server.BlenderConnection._send_command_locked = send_locked

    for request_type, original in tuple(server.mcp._mcp_server.request_handlers.items()):
        async def guarded(request, original=original):
            return guard.annotate(await original(request), types)
        server.mcp._mcp_server.request_handlers[request_type] = guarded

    # Upstream's lifespan performs addon/status/update probes before any RPC and
    # telemetry work after it. All addon commands here belong to an actual request.
    @asynccontextmanager
    async def owned_lifespan(_server):
        yield {}
    server.mcp._mcp_server.lifespan = owned_lifespan
    return guard


def main():
    if metadata.version("mcp-for-blender") != "2.1.7" or metadata.version("mcp") != "1.29.0":
        raise RuntimeError("This Blender bridge requires mcp-for-blender 2.1.7 and mcp 1.29.0")
    for module, expected in (("blender_mcp.server", SERVER_SHA256), ("blender_mcp.telemetry", TELEMETRY_SHA256)):
        spec = util.find_spec(module)
        if not spec or not spec.origin or hashlib.sha256(Path(spec.origin).read_bytes()).hexdigest() != expected:
            raise RuntimeError("The installed Blender MCP source does not match the reviewed pin")
    import mcp.types as types
    from blender_mcp import telemetry
    install_disabled_telemetry(telemetry)
    from blender_mcp import server
    install_guard(server, types)
    server.main()


if __name__ == "__main__":
    main()
