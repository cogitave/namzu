// Namzu Helper: the macOS accessibility and window-capture helper of @namzu/computer-use.
//
// A small background app (no Dock icon) that LaunchServices starts in the person's own GUI
// session, so the Accessibility and Screen Recording permissions belong to "Namzu Helper" and
// not to a terminal or to sshd. It answers JSON lines over a unix socket (mode 0600, owner only):
//
//   permissions, windows, displays, snapshot, seq, wait_change, identity, resolve, act,
//   focus, capture_window, scroll, selfcheck, quit (ends the connection), shutdown (ends the app)
//
// Every request is {"id": n, "cmd": "...", ...}; every reply is {"id": n, "ok": true, ...} or
// {"id": n, "ok": false, "code": "...", "message": "..."}. The first line the helper sends on a
// connection is {"ok": true, "hello": true, "version": 1, ...}.
//
// Rectangles are physical pixels of the main display (points times its backing scale), the unit
// the host contract uses; window ids are CGWindowIDs.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// MARK: - Private SPI (long-standing, used by every accessibility client to map a window)

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ identifier: UnsafeMutablePointer<CGWindowID>) -> AXError

// MARK: - Constants

let protocolVersion = 1
let buildId = CommandLine.arguments.firstIndex(of: "--build").flatMap { i in
    i + 1 < CommandLine.arguments.count ? CommandLine.arguments[i + 1] : nil
} ?? "dev"
let socketPath: String = CommandLine.arguments.firstIndex(of: "--socket").flatMap { i in
    i + 1 < CommandLine.arguments.count ? CommandLine.arguments[i + 1] : nil
} ?? ""
let idleExitSeconds: TimeInterval = 15 * 60

typealias Json = [String: Any]

// MARK: - Small helpers

func fnv(_ text: String) -> String {
    var h: UInt64 = 0xcbf29ce484222325
    for b in text.utf8 {
        h ^= UInt64(b)
        h = h &* 0x100000001b3
    }
    return String(h, radix: 16)
}

struct HelperError: Error {
    let code: String
    let message: String
}

func num(_ v: Any?, _ fallback: Double = 0) -> Double {
    if let n = v as? NSNumber { return n.doubleValue }
    return fallback
}

func intOf(_ v: Any?) -> Int? {
    if let n = v as? NSNumber { return n.intValue }
    return nil
}

/// Runs on the main thread (AppKit's screens and workspace are read there), without waiting on itself.
func onMain<T>(_ body: () -> T) -> T {
    Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
}

/// Pixels per point of the main display, as a capture sees it.
func mainScale() -> Double {
    onMain { Double(NSScreen.screens.first?.backingScaleFactor ?? 1) }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

// MARK: - Permissions

func accessibilityTrusted(prompt: Bool) -> Bool {
    if prompt {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }
    return AXIsProcessTrusted()
}

func screenCaptureAllowed(prompt: Bool) -> Bool {
    if prompt { return CGRequestScreenCaptureAccess() }
    return CGPreflightScreenCaptureAccess()
}

func permissionsReply(prompt: Bool) -> Json {
    let ax = accessibilityTrusted(prompt: prompt)
    let sc = screenCaptureAllowed(prompt: prompt)
    let appName = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Namzu Helper"
    var steps: [String] = []
    if !ax {
        steps.append("System Settings > Privacy & Security > Accessibility: turn on \"\(appName)\".")
    }
    if !sc {
        steps.append("System Settings > Privacy & Security > Screen & System Audio Recording: turn on \"\(appName)\".")
    }
    return [
        "accessibility": ax,
        "screenCapture": sc,
        "app": appName,
        "bundleId": Bundle.main.bundleIdentifier ?? "",
        "path": Bundle.main.bundlePath,
        "steps": steps,
    ]
}

// MARK: - Process info

final class ProcessInfoCache {
    private let lock = NSLock()
    private var starts: [pid_t: Double] = [:]
    private var chromium: [pid_t: Bool] = [:]
    private var activated: Set<pid_t> = []

    func start(_ pid: pid_t) -> Double {
        lock.lock(); defer { lock.unlock() }
        if let s = starts[pid] { return s }
        var value: Double = 0
        if let d = NSRunningApplication(processIdentifier: pid)?.launchDate {
            value = (d.timeIntervalSince1970 * 1000).rounded()
        }
        starts[pid] = value
        return value
    }

    func isChromium(_ pid: pid_t) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let c = chromium[pid] { return c }
        var result = false
        if let app = NSRunningApplication(processIdentifier: pid) {
            let id = app.bundleIdentifier ?? ""
            let prefixes = [
                "com.google.Chrome", "org.chromium", "com.microsoft.edgemac", "com.brave.Browser",
                "company.thebrowser", "com.operasoftware", "com.vivaldi", "com.github.Electron",
            ]
            if prefixes.contains(where: { id.hasPrefix($0) }) { result = true }
            if let url = app.bundleURL {
                let fm = FileManager.default
                let frameworks = url.appendingPathComponent("Contents/Frameworks")
                for name in ["Electron Framework.framework", "Chromium Embedded Framework.framework"] {
                    if fm.fileExists(atPath: frameworks.appendingPathComponent(name).path) { result = true }
                }
            }
        }
        chromium[pid] = result
        return result
    }

    /// Chromium and Electron build their accessibility tree only when asked; this asks, once per process.
    func activateChromium(_ pid: pid_t, app: AXUIElement) {
        lock.lock()
        let already = activated.contains(pid)
        activated.insert(pid)
        lock.unlock()
        if already { return }
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }
}

let procInfo = ProcessInfoCache()

// MARK: - Windows

struct WindowEntry {
    let id: Int
    let pid: pid_t
    let owner: String
    let title: String
    let bounds: CGRect  // points
    let layer: Int
    let z: Int
}

func listWindowEntries() -> [WindowEntry] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var out: [WindowEntry] = []
    var z = 0
    for w in raw {
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        guard layer == 0 else { continue }
        let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1
        if alpha <= 0.01 { continue }
        guard let id = w[kCGWindowNumber as String] as? Int,
              let pid = w[kCGWindowOwnerPID as String] as? Int,
              let bd = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let rect = CGRect(
            x: num(bd["X"]), y: num(bd["Y"]), width: num(bd["Width"]), height: num(bd["Height"]))
        if rect.width < 24 || rect.height < 24 { continue }
        out.append(WindowEntry(
            id: id, pid: pid_t(pid), owner: (w[kCGWindowOwnerName as String] as? String) ?? "",
            title: (w[kCGWindowName as String] as? String) ?? "", bounds: rect, layer: layer, z: z))
        z += 1
    }
    return out
}

func appElement(_ pid: pid_t) -> AXUIElement {
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, 2.0)
    return el
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return err == .success ? v : nil
}

func frontmostPid() -> pid_t? {
    onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
}

func focusedWindowId(pid: pid_t) -> Int? {
    let app = appElement(pid)
    guard let w = attr(app, kAXFocusedWindowAttribute as String) else { return nil }
    var id: CGWindowID = 0
    if _AXUIElementGetWindow(w as! AXUIElement, &id) == .success, id != 0 { return Int(id) }
    return nil
}

func windowsReply() -> Json {
    let scale = mainScale()
    let front = frontmostPid()
    var frontId: Int?
    if let f = front { frontId = focusedWindowId(pid: f) }
    let me = ProcessInfo.processInfo.processIdentifier
    var list: [Json] = []
    var firstOfFront: Int?
    let entries = listWindowEntries().filter { $0.pid != me }
    for e in entries where e.pid == front && firstOfFront == nil { firstOfFront = e.id }
    let focusedId = frontId ?? firstOfFront
    for e in entries {
        list.append([
            "hwnd": e.id, "pid": Int(e.pid), "process": e.owner, "title": e.title,
            "x": Int((e.bounds.origin.x * scale).rounded()), "y": Int((e.bounds.origin.y * scale).rounded()),
            "width": Int((e.bounds.width * scale).rounded()), "height": Int((e.bounds.height * scale).rounded()),
            "minimized": false, "focused": e.id == focusedId, "z": e.z,
        ])
    }
    return ["windows": list]
}

func displaysReply() -> Json {
    var out: [Json] = []
    onMain {
        let screens = NSScreen.screens
        let main = screens.first
        let scale = Double(main?.backingScaleFactor ?? 1)
        let mainHeight = main?.frame.height ?? 0
        for (i, s) in screens.enumerated() {
            let did = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? i
            // Cocoa has a bottom-left origin; the host uses a top-left one, as CGWindowList does.
            let f = s.frame
            let v = s.visibleFrame
            let top = mainHeight - f.maxY
            let vtop = mainHeight - v.maxY
            out.append([
                "id": String(did), "x": Int((f.origin.x * scale).rounded()), "y": Int((top * scale).rounded()),
                "width": Int((f.width * scale).rounded()), "height": Int((f.height * scale).rounded()),
                "workX": Int((v.origin.x * scale).rounded()), "workY": Int((vtop * scale).rounded()),
                "workWidth": Int((v.width * scale).rounded()), "workHeight": Int((v.height * scale).rounded()),
                "scale": Double(s.backingScaleFactor), "primary": i == 0,
            ])
        }
    }
    return ["displays": out]
}

// MARK: - Element registry (a ref names the control, not one reading of it)

final class ElementRegistry {
    private let lock = NSLock()
    private var byRuntime: [String: AXUIElement] = [:]
    private var order: [String] = []
    private let cap = 30_000

    func put(_ id: String, _ el: AXUIElement) {
        lock.lock(); defer { lock.unlock() }
        if byRuntime[id] == nil { order.append(id) }
        byRuntime[id] = el
        if order.count > cap {
            let drop = order.prefix(order.count - cap)
            for k in drop { byRuntime.removeValue(forKey: k) }
            order.removeFirst(order.count - cap)
        }
    }

    func get(_ id: String) -> AXUIElement? {
        lock.lock(); defer { lock.unlock() }
        return byRuntime[id]
    }
}

let registry = ElementRegistry()

func runtimeId(_ el: AXUIElement, pid: pid_t) -> String { "\(pid):\(CFHash(el))" }

// MARK: - Reading the tree

struct Fingerprint {
    var runtimeId: String
    var automationId: String
    var role: String
    var nameHash: String
    var parentPath: String
    var ordinal: Int
    var processStart: Double

    var json: Json {
        [
            "runtimeId": runtimeId, "automationId": automationId, "role": role, "nameHash": nameHash,
            "parentPath": parentPath, "ordinal": ordinal, "processStart": processStart,
        ]
    }

    static func from(_ j: Json) -> Fingerprint {
        Fingerprint(
            runtimeId: (j["runtimeId"] as? String) ?? "", automationId: (j["automationId"] as? String) ?? "",
            role: (j["role"] as? String) ?? "", nameHash: (j["nameHash"] as? String) ?? "",
            parentPath: (j["parentPath"] as? String) ?? "", ordinal: intOf(j["ordinal"]) ?? 0,
            processStart: num(j["processStart"]))
    }
}

final class ReadNode {
    var element: AXUIElement
    var parent: Int
    var depth: Int
    var role = ""
    var subrole = ""
    var name = ""
    var identifier = ""
    var rect = CGRect.zero  // points
    var enabled = true
    var focused = false
    var selected: Bool?
    var value: String?
    var toggle: String?
    var expand: String?
    var actions: [String] = []
    var childCount: Int?
    var children: [Int] = []
    var fingerprint: Fingerprint?

    init(_ e: AXUIElement, parent: Int, depth: Int) {
        element = e
        self.parent = parent
        self.depth = depth
    }
}

struct Snapshot {
    var revision: Int
    var windowId: Int
    var pid: pid_t
    var nodes: [ReadNode]  // depth-first order
    var total: Int
    var truncated: Bool
    var readMs: Int
    var selectedText: String?
    var app: String
    var title: String
}

func cfString(_ v: CFTypeRef?) -> String? {
    guard let v = v else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() { return (v as! String) }
    return nil
}

func cfBool(_ v: CFTypeRef?) -> Bool? {
    guard let v = v else { return nil }
    if CFGetTypeID(v) == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    return nil
}

func axPoint(_ v: CFTypeRef?) -> CGPoint? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ v: CFTypeRef?) -> CGSize? {
    guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

let batchNames: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    "AXIdentifier", kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXSelectedAttribute, kAXChildrenAttribute, kAXExpandedAttribute, "AXDisclosing", kAXPlaceholderValueAttribute,
]

let noActionRoles: Set<String> = ["AXStaticText", "AXImage", "AXSplitter", "AXLayoutArea", "AXLayoutItem", "AXUnknown"]
let toggleRoles: Set<String> = ["AXCheckBox", "AXSwitch", "AXToggle", "AXMenuItem", "AXRadioButton"]
let lazyRoles: Set<String> = ["AXMenuBarItem", "AXMenuItem"]

func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var s: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, name as CFString, &s) == .success && s.boolValue
}

func readNode(_ node: ReadNode, expandChildren: Bool) -> [AXUIElement] {
    let el = node.element
    var raw: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(
        el, batchNames as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
    var values: [CFTypeRef?] = Array(repeating: nil, count: batchNames.count)
    if err == .success, let arr = raw as? [AnyObject] {
        for (i, v) in arr.enumerated() where i < values.count {
            let ref = v as CFTypeRef
            // A missing attribute comes back as an AXValue of type .axError.
            if CFGetTypeID(ref) == AXValueGetTypeID(), AXValueGetType(ref as! AXValue) == .axError { continue }
            values[i] = ref
        }
    }
    node.role = cfString(values[0]) ?? ""
    node.subrole = cfString(values[1]) ?? ""
    let title = cfString(values[2]) ?? ""
    let desc = cfString(values[3]) ?? ""
    let placeholder = cfString(values[14]) ?? ""
    node.identifier = cfString(values[5]) ?? ""
    var valueText: String?
    if let v = values[4] {
        if let s = cfString(v) { valueText = s }
        else if CFGetTypeID(v) == CFNumberGetTypeID() { valueText = (v as! NSNumber).stringValue }
        else if let b = cfBool(v) { valueText = b ? "1" : "0" }
    }
    if node.role == "AXStaticText" {
        node.name = !title.isEmpty ? title : (!desc.isEmpty ? desc : (valueText ?? ""))
    } else {
        node.name = !title.isEmpty ? title : (!desc.isEmpty ? desc : placeholder)
    }
    if let p = axPoint(values[6]), let s = axSize(values[7]) { node.rect = CGRect(origin: p, size: s) }
    node.enabled = cfBool(values[8]) ?? true
    node.focused = cfBool(values[9]) ?? false
    node.selected = cfBool(values[10])
    if toggleRoles.contains(node.role), node.role != "AXMenuItem" || node.subrole == "AXMenuItemMarkChar" {
        if let v = values[4] {
            let n = (v as? NSNumber)?.intValue ?? -1
            node.toggle = n == 0 ? "off" : (n == 1 ? "on" : (n == 2 ? "mixed" : nil))
        }
    } else if node.role == "AXCheckBox" {
        node.toggle = nil
    }
    if node.toggle == nil, let v = valueText, node.role != "AXStaticText" {
        node.value = String(v.prefix(2000))
    }
    if let e = cfBool(values[12]) ?? cfBool(values[13]) { node.expand = e ? "expanded" : "collapsed" }

    if !noActionRoles.contains(node.role) {
        var names: CFArray?
        if AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] {
            if list.contains("AXPress") || list.contains("AXOpen") || list.contains("AXConfirm") || list.contains("AXPick") {
                node.actions.append("invoke")
            }
            if list.contains("AXIncrement") || list.contains("AXDecrement") { node.actions.append("value") }
            if list.contains("AXShowMenu") && node.actions.isEmpty { /* context menu only: not a plain action */ }
        }
        if isSettable(el, kAXValueAttribute as String), !node.actions.contains("value"),
           node.role != "AXCheckBox", node.role != "AXRadioButton", node.role != "AXSwitch" {
            node.actions.append("value")
        }
        if node.toggle != nil, !node.actions.contains("toggle") { node.actions.append("toggle") }
        if node.expand != nil || node.role == "AXDisclosureTriangle" {
            if !node.actions.contains("expandCollapse") { node.actions.append("expandCollapse") }
        }
        if node.selected != nil, isSettable(el, kAXSelectedAttribute as String) || node.role == "AXRadioButton" || node.role == "AXTab" {
            node.actions.append("selectionItem")
        } else if node.role == "AXRadioButton" || node.role == "AXTab" || node.role == "AXRow" && node.selected != nil {
            node.actions.append("selectionItem")
        }
        if node.role == "AXScrollArea" || node.role == "AXScrollBar" { node.actions.append("scroll") }
    }

    var kids: [AXUIElement] = []
    if let arr = values[11], CFGetTypeID(arr) == CFArrayGetTypeID() {
        kids = (arr as! [AnyObject]).map { $0 as! AXUIElement }
    }
    node.childCount = kids.count
    if node.role == "AXMenuBar" || node.role == "AXMenu" || node.role == "AXMenuBarItem" || node.role == "AXMenuItem" {
        // Menus have their children listed when asked for, as a window's do.
    }
    if lazyRoles.contains(node.role) && !expandChildren { return [] }
    return kids
}

func fingerprintFor(_ nodes: [ReadNode], at i: Int, pid: pid_t) -> Fingerprint {
    let n = nodes[i]
    let label = n.name.isEmpty ? (n.value ?? "") : n.name
    var chain: [String] = []
    var p = n.parent
    while p >= 0 && chain.count < 8 {
        let a = nodes[p]
        chain.append("\(a.role)|\(fnv(a.name))")
        p = a.parent
    }
    var ordinal = 0
    if n.parent >= 0 {
        for sib in nodes[n.parent].children {
            if sib == i { break }
            let s = nodes[sib]
            if s.role == n.role && fnv(s.name) == fnv(n.name) { ordinal += 1 }
        }
    }
    return Fingerprint(
        runtimeId: runtimeId(n.element, pid: pid), automationId: n.identifier, role: n.role,
        nameHash: fnv(label.isEmpty ? "" : (n.name.isEmpty ? "" : n.name)), parentPath: chain.reversed().joined(separator: "/"),
        ordinal: ordinal, processStart: procInfo.start(pid))
}

final class SnapshotCache {
    private let lock = NSLock()
    private var byWindow: [Int: Snapshot] = [:]
    private var revision = 0

    func nextRevision() -> Int {
        lock.lock(); defer { lock.unlock() }
        revision += 1
        return revision
    }

    func put(_ s: Snapshot) {
        lock.lock(); defer { lock.unlock() }
        byWindow[s.windowId] = s
    }

    func get(_ w: Int) -> Snapshot? {
        lock.lock(); defer { lock.unlock() }
        return byWindow[w]
    }
}

let snapshots = SnapshotCache()

func axWindowElement(windowId: Int, pid: pid_t) -> AXUIElement? {
    let app = appElement(pid)
    guard let list = attr(app, kAXWindowsAttribute as String), CFGetTypeID(list) == CFArrayGetTypeID() else { return nil }
    let all = (list as! [AnyObject]).map { $0 as! AXUIElement }
    for el in all {
        var id: CGWindowID = 0
        if _AXUIElementGetWindow(el, &id) == .success, Int(id) == windowId { return el }
    }
    // The private call is not answered for every window; the window's own place and size name it as well.
    guard let entry = listWindowEntries().first(where: { $0.id == windowId }) else { return nil }
    let sameFrame = all.filter { el in
        guard let p = axPoint(attr(el, kAXPositionAttribute as String)), let s = axSize(attr(el, kAXSizeAttribute as String)) else { return false }
        return abs(p.x - entry.bounds.origin.x) < 2 && abs(p.y - entry.bounds.origin.y) < 2
            && abs(s.width - entry.bounds.width) < 2 && abs(s.height - entry.bounds.height) < 2
    }
    if sameFrame.count == 1 { return sameFrame[0] }
    if sameFrame.count > 1, !entry.title.isEmpty,
       let titled = sameFrame.first(where: { cfString(attr($0, kAXTitleAttribute as String)) == entry.title }) {
        return titled
    }
    return nil
}

func entryFor(windowId: Int) throws -> WindowEntry {
    if let e = listWindowEntries().first(where: { $0.id == windowId }) { return e }
    throw HelperError(code: "window_gone", message: "that window is not on screen any more; list the windows again")
}

/// Accessibility is needed for any other app's windows; reading this helper's own windows needs none,
/// which is what lets the helper test itself before the person has granted anything.
func requireAccessibility(pid: pid_t? = nil) throws {
    if let p = pid, p == ProcessInfo.processInfo.processIdentifier { return }
    if !AXIsProcessTrusted() {
        let name = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Namzu Helper"
        throw HelperError(
            code: "accessibility_denied",
            message: "Accessibility is off for \(name). Open System Settings > Privacy & Security > Accessibility and turn on \"\(name)\", then try again.")
    }
}

func readTree(
    rootElement: AXUIElement, rootParent: Int = -1, windowId: Int, pid: pid_t, windowTitle: String,
    appName: String, maxNodes: Int, maxDepth: Int, deadline: Date, includeMenuBar: Bool, drillRoot: Bool
) -> Snapshot {
    let started = Date()
    var nodes: [ReadNode] = []
    let root = ReadNode(rootElement, parent: -1, depth: 0)
    nodes.append(root)
    var queue: [Int] = [0]
    var head = 0
    var truncated = false
    var expandedRoot = false
    while head < queue.count {
        let i = queue[head]; head += 1
        if Date() > deadline { truncated = true; break }
        let node = nodes[i]
        let kids = readNode(node, expandChildren: drillRoot && !expandedRoot)
        if i == 0 { expandedRoot = true }
        if node.depth >= maxDepth { if !kids.isEmpty { truncated = true }; continue }
        for k in kids {
            if nodes.count >= maxNodes { truncated = true; break }
            let child = ReadNode(k, parent: i, depth: node.depth + 1)
            nodes.append(child)
            node.children.append(nodes.count - 1)
            queue.append(nodes.count - 1)
        }
    }
    // The nodes that were queued but never read (a cut) still need their own facts.
    if head < queue.count {
        for j in head..<queue.count where nodes[j].role.isEmpty {
            if Date() > deadline.addingTimeInterval(1.5) { break }
            _ = readNode(nodes[j], expandChildren: false)
        }
    }
    if includeMenuBar, !truncated || nodes.count < maxNodes {
        let app = appElement(pid)
        if let mb = attr(app, kAXMenuBarAttribute as String) {
            let bar = ReadNode(mb as! AXUIElement, parent: 0, depth: 1)
            let kids = readNode(bar, expandChildren: true)
            nodes.append(bar)
            nodes[0].children.append(nodes.count - 1)
            let barIndex = nodes.count - 1
            for k in kids {
                if nodes.count >= maxNodes + 40 { break }
                let item = ReadNode(k, parent: barIndex, depth: 2)
                _ = readNode(item, expandChildren: false)
                nodes.append(item)
                nodes[barIndex].children.append(nodes.count - 1)
            }
        }
    }
    // Depth-first order, so a node's index is its place in reading order.
    var order: [Int] = []
    func walk(_ i: Int) {
        order.append(i)
        for c in nodes[i].children { walk(c) }
    }
    walk(0)
    var remap = [Int: Int]()
    for (n, old) in order.enumerated() { remap[old] = n }
    var sorted: [ReadNode] = []
    for old in order {
        let n = nodes[old]
        n.parent = n.parent < 0 ? -1 : (remap[n.parent] ?? -1)
        n.children = n.children.compactMap { remap[$0] }
        sorted.append(n)
    }
    for i in sorted.indices {
        let fp = fingerprintFor(sorted, at: i, pid: pid)
        sorted[i].fingerprint = fp
        registry.put(fp.runtimeId, sorted[i].element)
    }
    var hidden = 0
    for n in sorted where n.children.isEmpty { hidden += n.childCount ?? 0 }
    var selectedText: String?
    let app = appElement(pid)
    if let focused = attr(app, kAXFocusedUIElementAttribute as String),
       let t = cfString(attr(focused as! AXUIElement, kAXSelectedTextAttribute as String)), !t.isEmpty {
        selectedText = String(t.prefix(2000))
    }
    return Snapshot(
        revision: snapshots.nextRevision(), windowId: windowId, pid: pid, nodes: sorted,
        total: sorted.count + hidden, truncated: truncated,
        readMs: Int(Date().timeIntervalSince(started) * 1000), selectedText: selectedText, app: appName, title: windowTitle)
}

func nodeJson(_ n: ReadNode, index: Int, scale: Double, window: CGRect) -> Json {
    var j: Json = [
        "index": index, "parent": n.parent, "depth": n.depth, "role": n.role,
        "rect": [
            Int((n.rect.origin.x * scale).rounded()), Int((n.rect.origin.y * scale).rounded()),
            Int((n.rect.width * scale).rounded()), Int((n.rect.height * scale).rounded()),
        ],
        "enabled": n.enabled,
        "offscreen": n.rect.width <= 0 || n.rect.height <= 0 || !n.rect.intersects(window),
        "focused": n.focused, "actions": n.actions,
    ]
    if !n.name.isEmpty { j["name"] = String(n.name.prefix(400)) }
    if !n.identifier.isEmpty { j["automationId"] = n.identifier }
    if !n.subrole.isEmpty { j["className"] = n.subrole }
    if let v = n.value { j["value"] = v }
    if let t = n.toggle { j["toggle"] = t }
    if let e = n.expand { j["expand"] = e }
    if let s = n.selected { j["selected"] = s }
    if n.children.isEmpty, let c = n.childCount, c > 0 { j["childCount"] = c }
    return j
}

func snapshotReply(_ req: Json) throws -> Json {
    guard let windowId = intOf(req["hwnd"]) else { throw HelperError(code: "bad_request", message: "hwnd is required") }
    let entry = try entryFor(windowId: windowId)
    try requireAccessibility(pid: entry.pid)
    let allowChromium = (req["allowChromium"] as? Bool) == true
    let app = appElement(entry.pid)
    if procInfo.isChromium(entry.pid) {
        if !allowChromium {
            throw HelperError(
                code: "chromium_not_activated",
                message: "\(entry.owner) is a Chromium or Electron app; reading it switches its accessibility on for the rest of the session. Ask again with allowChromium.")
        }
        procInfo.activateChromium(entry.pid, app: app)
    }
    guard let windowElement = axWindowElement(windowId: windowId, pid: entry.pid) else {
        var probe: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &probe)
        throw HelperError(
            code: "no_ax_window",
            message: "\(entry.owner) did not expose that window to accessibility (\(axErrorText(err)), \((probe as? [AnyObject])?.count ?? -1) windows)")
    }
    let maxNodes = max(1, intOf(req["maxNodes"]) ?? 400)
    let maxDepth = max(1, intOf(req["maxDepth"]) ?? 12)
    let timeoutMs = max(200, intOf(req["timeoutMs"]) ?? 8000)
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0 * 0.85)
    let skeleton = (req["skeleton"] as? Bool) == true
    var rootEl = windowElement
    var drill = false
    var includeMenu = !skeleton
    if let rootFp = req["root"] as? Json {
        let fp = Fingerprint.from(rootFp)
        guard let el = try locate(fp, windowId: windowId, pid: entry.pid, allowFresh: false).element else {
            throw HelperError(code: "not_found", message: "the region is no longer in the window")
        }
        rootEl = el
        drill = true
        includeMenu = false
    }
    let snap = readTree(
        rootElement: rootEl, windowId: windowId, pid: entry.pid, windowTitle: entry.title, appName: entry.owner,
        maxNodes: skeleton ? min(maxNodes, 60) : maxNodes, maxDepth: skeleton ? 2 : maxDepth, deadline: deadline,
        includeMenuBar: includeMenu, drillRoot: drill)
    if !drill { snapshots.put(snap) }
    let scale = mainScale()
    var nodes: [Json] = []
    for (i, n) in snap.nodes.enumerated() {
        var j = nodeJson(n, index: i, scale: scale, window: entry.bounds)
        if let fp = n.fingerprint { j["fp"] = fp.json }
        nodes.append(j)
    }
    var reply: Json = [
        "rev": snap.revision, "nodes": nodes, "total": snap.total, "truncated": snap.truncated,
        "skeleton": skeleton, "readMs": snap.readMs, "app": snap.app, "title": snap.title, "pid": Int(snap.pid),
    ]
    if let t = snap.selectedText { reply["selectedText"] = t }
    return reply
}

// MARK: - Finding a control again

struct Located {
    var element: AXUIElement?
    var via: String
    var code: String?
    var candidates: Int?
    var index: Int?
    var revision: Int?
}

func elementIsLive(_ el: AXUIElement) -> Bool {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, kAXRoleAttribute as CFString, &v)
    return err == .success
}

func locate(_ fp: Fingerprint, windowId: Int, pid: pid_t, allowFresh: Bool) throws -> Located {
    if fp.processStart != 0, procInfo.start(pid) != fp.processStart {
        return Located(element: nil, via: "", code: "not_found", candidates: nil, index: nil, revision: nil)
    }
    if let el = registry.get(fp.runtimeId), elementIsLive(el) {
        let role = cfString(attr(el, kAXRoleAttribute as String)) ?? ""
        if fp.role.isEmpty || role == fp.role {
            return Located(element: el, via: "runtimeId", code: nil, candidates: nil, index: nil, revision: nil)
        }
    }
    guard allowFresh else {
        return Located(element: nil, via: "", code: "not_found", candidates: nil, index: nil, revision: nil)
    }
    let entry = try entryFor(windowId: windowId)
    guard let win = axWindowElement(windowId: windowId, pid: pid) else {
        return Located(element: nil, via: "", code: "not_found", candidates: nil, index: nil, revision: nil)
    }
    let snap = readTree(
        rootElement: win, windowId: windowId, pid: pid, windowTitle: entry.title, appName: entry.owner,
        maxNodes: 3000, maxDepth: 16, deadline: Date().addingTimeInterval(6), includeMenuBar: true, drillRoot: false)
    snapshots.put(snap)
    func result(_ idx: [Int], _ via: String) -> Located? {
        if idx.count == 1 {
            return Located(
                element: snap.nodes[idx[0]].element, via: via, code: nil, candidates: nil, index: idx[0], revision: snap.revision)
        }
        return nil
    }
    if !fp.automationId.isEmpty {
        let c = snap.nodes.indices.filter { snap.nodes[$0].fingerprint?.automationId == fp.automationId && snap.nodes[$0].role == fp.role }
        if let r = result(c, "automationId") { return r }
        if c.count > 1 {
            let byName = c.filter { snap.nodes[$0].fingerprint?.nameHash == fp.nameHash }
            if let r = result(byName, "automationId") { return r }
            return Located(element: nil, via: "", code: "ambiguous", candidates: c.count, index: nil, revision: snap.revision)
        }
    }
    var c = snap.nodes.indices.filter { snap.nodes[$0].role == fp.role && snap.nodes[$0].fingerprint?.nameHash == fp.nameHash }
    if let r = result(c, "name") { return r }
    if c.count > 1 {
        let byPath = c.filter { snap.nodes[$0].fingerprint?.parentPath == fp.parentPath }
        if let r = result(byPath, "name") { return r }
        if !byPath.isEmpty { c = byPath }
        let byOrd = c.filter { snap.nodes[$0].fingerprint?.ordinal == fp.ordinal && snap.nodes[$0].fingerprint?.parentPath == fp.parentPath }
        if let r = result(byOrd, "name") { return r }
        return Located(element: nil, via: "", code: "ambiguous", candidates: c.count, index: nil, revision: snap.revision)
    }
    return Located(element: nil, via: "", code: "not_found", candidates: nil, index: nil, revision: snap.revision)
}

func fingerprintFromRequest(_ req: Json) throws -> (Fingerprint, Int, pid_t) {
    guard let windowId = intOf(req["hwnd"]) else { throw HelperError(code: "bad_request", message: "hwnd is required") }
    let entry = try entryFor(windowId: windowId)
    if let f = req["fingerprint"] as? Json { return (Fingerprint.from(f), windowId, entry.pid) }
    if let index = intOf(req["index"]) {
        guard let snap = snapshots.get(windowId), index >= 0, index < snap.nodes.count, let fp = snap.nodes[index].fingerprint else {
            throw HelperError(code: "stale_snapshot", message: "that read of the window is gone; take a new snapshot")
        }
        if let rev = intOf(req["rev"]), rev != snap.revision {
            throw HelperError(code: "stale_snapshot", message: "the window was read again since that snapshot")
        }
        return (fp, windowId, entry.pid)
    }
    throw HelperError(code: "bad_request", message: "index or fingerprint is required")
}

func identityReply(_ req: Json) throws -> Json {
    let (fp, _, _) = try fingerprintFromRequest(req)
    return ["fingerprint": fp.json]
}

func resolveReply(_ req: Json) throws -> Json {
    guard let windowId = intOf(req["hwnd"]), let fpj = req["fingerprint"] as? Json else {
        throw HelperError(code: "bad_request", message: "hwnd and fingerprint are required")
    }
    let entry = try entryFor(windowId: windowId)
    try requireAccessibility(pid: entry.pid)
    let loc = try locate(Fingerprint.from(fpj), windowId: windowId, pid: entry.pid, allowFresh: true)
    if loc.element != nil {
        // A runtime-id hit did not read the window; the index is in the latest read when there is one.
        var idx = loc.index
        var rev = loc.revision
        if idx == nil, let snap = snapshots.get(windowId) {
            let rid = Fingerprint.from(fpj).runtimeId
            idx = snap.nodes.firstIndex { $0.fingerprint?.runtimeId == rid }
            rev = snap.revision
        }
        return ["found": true, "index": idx ?? -1, "via": loc.via, "rev": rev ?? 0]
    }
    var r: Json = ["found": false, "code": loc.code ?? "not_found"]
    if let c = loc.candidates { r["candidates"] = c }
    return r
}

// MARK: - Acting

func perform(_ el: AXUIElement, _ action: String) -> AXError {
    AXUIElementPerformAction(el, action as CFString)
}

func readState(_ el: AXUIElement) -> String {
    if let v = attr(el, kAXValueAttribute as String) {
        if let s = cfString(v) { return s }
        if let n = v as? NSNumber { return n.stringValue }
    }
    if let e = cfBool(attr(el, kAXExpandedAttribute as String)) { return e ? "expanded" : "collapsed" }
    if let s = cfBool(attr(el, kAXSelectedAttribute as String)) { return s ? "selected" : "not selected" }
    return ""
}

func axErrorText(_ e: AXError) -> String {
    switch e {
    case .success: return "ok"
    case .apiDisabled: return "accessibility is off for this helper"
    case .actionUnsupported: return "the control does not offer that action"
    case .attributeUnsupported: return "the control does not have that property"
    case .cannotComplete: return "the app did not answer in time"
    case .invalidUIElement: return "the control is gone"
    case .notImplemented: return "the app does not implement accessibility for this control"
    case .noValue: return "the control has no value"
    default: return "accessibility error \(e.rawValue)"
    }
}

func actReply(_ req: Json) throws -> Json {
    let (fp, windowId, pid) = try fingerprintFromRequest(req)
    try requireAccessibility(pid: pid)
    let loc = try locate(fp, windowId: windowId, pid: pid, allowFresh: true)
    guard let el = loc.element else {
        let code = loc.code == "ambiguous" ? "AMBIGUOUS_TARGET" : "STALE_REF"
        throw HelperError(code: code, message: loc.code == "ambiguous"
            ? "\(loc.candidates ?? 2) controls fit that reference; take a new snapshot"
            : "the control is no longer in the window; take a new snapshot")
    }
    let action = (req["action"] as? String) ?? "invoke"
    let value = req["value"] as? String
    let before = readState(el)
    var expected: String?
    var err: AXError = .success
    switch action {
    case "invoke", "press":
        err = perform(el, "AXPress")
        if err == .actionUnsupported {
            let alt = ["AXOpen", "AXConfirm", "AXPick"].first { name in
                var names: CFArray?
                return AXUIElementCopyActionNames(el, &names) == .success && ((names as? [String]) ?? []).contains(name)
            }
            if let alt = alt { err = perform(el, alt) }
        }
    case "show_menu": err = perform(el, "AXShowMenu")
    case "raise": err = perform(el, "AXRaise")
    case "increment": err = perform(el, "AXIncrement")
    case "decrement": err = perform(el, "AXDecrement")
    case "scroll_into_view": err = perform(el, "AXScrollToVisible")
    case "focus":
        err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "set_value":
        guard let v = value else { throw HelperError(code: "bad_request", message: "set_value needs a value") }
        expected = v
        let role = cfString(attr(el, kAXRoleAttribute as String)) ?? ""
        if role == "AXSlider" || role == "AXStepper" || role == "AXIncrementor", let d = Double(v) {
            err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, NSNumber(value: d))
        } else {
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, v as CFString)
        }
    case "toggle":
        err = perform(el, "AXPress")
    case "select":
        if isSettable(el, kAXSelectedAttribute as String) {
            err = AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue)
            expected = "selected"
        } else {
            err = perform(el, "AXPress")
        }
    case "expand", "collapse":
        let want = action == "expand"
        expected = want ? "expanded" : "collapsed"
        let name = attr(el, "AXDisclosing" as String) != nil ? "AXDisclosing" : (kAXExpandedAttribute as String)
        if isSettable(el, name) {
            err = AXUIElementSetAttributeValue(el, name as CFString, want ? kCFBooleanTrue : kCFBooleanFalse)
        } else {
            let state = cfBool(attr(el, name))
            if state == want { err = .success } else { err = perform(el, "AXPress") }
        }
    default:
        throw HelperError(code: "bad_request", message: "unknown action \(action)")
    }
    if err != .success {
        return [
            "done": false, "delivery": "not_delivered", "detail": axErrorText(err), "axError": Int(err.rawValue),
        ]
    }
    // Let the app apply it, then read it back.
    Thread.sleep(forTimeInterval: 0.12)
    var after = readState(el)
    if action == "toggle" || action == "invoke" || action == "press" || action == "select" {
        if after == before && (action == "toggle" || action == "select") {
            Thread.sleep(forTimeInterval: 0.25)
            after = readState(el)
        }
    }
    var reply: Json = ["done": true, "via": loc.via, "before": before, "after": after]
    if let e = expected {
        reply["expected"] = e
        reply["verified"] = (after == e)
    } else if action == "toggle" {
        reply["verified"] = (after != before)
        reply["expected"] = "not \(before)"
    }
    return reply
}

// MARK: - Focus, scroll, capture

func focusReply(_ req: Json) throws -> Json {
    guard let windowId = intOf(req["hwnd"]) else { throw HelperError(code: "bad_request", message: "hwnd is required") }
    let entry = try entryFor(windowId: windowId)
    onMain {
        if let app = NSRunningApplication(processIdentifier: entry.pid) {
            app.activate(options: [.activateAllWindows])
        }
    }
    if AXIsProcessTrusted(), let win = axWindowElement(windowId: windowId, pid: entry.pid) {
        _ = perform(win, "AXRaise")
        _ = AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
    Thread.sleep(forTimeInterval: 0.2)
    let front = frontmostPid()
    var focused: Int?
    if let f = front { focused = focusedWindowId(pid: f) ?? listWindowEntries().first(where: { $0.pid == f })?.id }
    return ["focusedId": focused as Any? ?? NSNull(), "ok": focused == windowId]
}

func scrollReply(_ req: Json) throws -> Json {
    try requireAccessibility()
    let entry: WindowEntry? = try intOf(req["hwnd"]).map { try entryFor(windowId: $0) }
    guard entry != nil || (req["x"] != nil && req["y"] != nil) else {
        throw HelperError(code: "bad_request", message: "hwnd or x and y are required")
    }
    let direction = (req["direction"] as? String) ?? "down"
    let amount = max(1, intOf(req["amount"]) ?? 3)
    var at = CGPoint(x: entry?.bounds.midX ?? 0, y: entry?.bounds.midY ?? 0)
    if let x = req["x"] as? NSNumber, let y = req["y"] as? NSNumber {
        // Points of the global screen space.
        at = CGPoint(x: x.doubleValue, y: y.doubleValue)
    }
    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = Int32(amount)
    case "down": dy = -Int32(amount)
    case "left": dx = Int32(amount)
    case "right": dx = -Int32(amount)
    default: throw HelperError(code: "bad_request", message: "unknown direction \(direction)")
    }
    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
        throw HelperError(code: "event_failed", message: "could not create a scroll event")
    }
    ev.location = at
    if let e = entry { ev.postToPid(e.pid) } else { ev.post(tap: .cghidEventTap) }
    Thread.sleep(forTimeInterval: 0.1)
    return ["done": true]
}

// MARK: - Input to a window (posted to its process, not to the screen's front)

func post(_ ev: CGEvent?, pid: pid_t?) {
    guard let ev = ev else { return }
    if let p = pid { ev.postToPid(p) } else { ev.post(tap: .cghidEventTap) }
}

func flagsOf(_ names: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for n in names {
        switch n {
        case "command": f.insert(.maskCommand)
        case "control": f.insert(.maskControl)
        case "option": f.insert(.maskAlternate)
        case "shift": f.insert(.maskShift)
        default: break
        }
    }
    return f
}

func clickReply(_ req: Json) throws -> Json {
    try requireAccessibility()
    guard let x = req["x"] as? NSNumber, let y = req["y"] as? NSNumber else {
        throw HelperError(code: "bad_request", message: "x and y are required")
    }
    let pid: pid_t? = try intOf(req["hwnd"]).map { try entryFor(windowId: $0).pid }
    let at = CGPoint(x: x.doubleValue, y: y.doubleValue)
    let button = (req["button"] as? String) ?? "left"
    let count = max(1, min(3, intOf(req["count"]) ?? 1))
    let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    if let to = req["to"] as? Json, let tx = to["x"] as? NSNumber, let ty = to["y"] as? NSNumber {
        let dragType: CGEventType = button == "right" ? .rightMouseDragged : .leftMouseDragged
        post(CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: at, mouseButton: cgButton), pid: pid)
        let steps = 12
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: at.x + (tx.doubleValue - at.x) * t, y: at.y + (ty.doubleValue - at.y) * t)
            post(CGEvent(mouseEventSource: nil, mouseType: dragType, mouseCursorPosition: p, mouseButton: cgButton), pid: pid)
            Thread.sleep(forTimeInterval: 0.012)
        }
        post(CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: CGPoint(x: tx.doubleValue, y: ty.doubleValue), mouseButton: cgButton), pid: pid)
        return ["done": true]
    }
    for n in 1...count {
        let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: at, mouseButton: cgButton)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        post(down, pid: pid)
        let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: at, mouseButton: cgButton)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        post(up, pid: pid)
        Thread.sleep(forTimeInterval: 0.03)
    }
    return ["done": true]
}

func typeReply(_ req: Json) throws -> Json {
    try requireAccessibility()
    guard let text = req["text"] as? String else { throw HelperError(code: "bad_request", message: "text is required") }
    let pid: pid_t? = try intOf(req["hwnd"]).map { try entryFor(windowId: $0).pid }
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(i + 16, units.count)])
        i += chunk.count
        for down in [true, false] {
            let ev = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            ev?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
            post(ev, pid: pid)
        }
        Thread.sleep(forTimeInterval: 0.008)
    }
    return ["done": true]
}

func keyReply(_ req: Json) throws -> Json {
    try requireAccessibility()
    guard let code = intOf(req["code"]) else { throw HelperError(code: "bad_request", message: "code is required") }
    let pid: pid_t? = try intOf(req["hwnd"]).map { try entryFor(windowId: $0).pid }
    let flags = flagsOf((req["flags"] as? [String]) ?? [])
    for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down)
        ev?.flags = flags
        post(ev, pid: pid)
        Thread.sleep(forTimeInterval: 0.01)
    }
    return ["done": true]
}

func pngData(_ image: CGImage) -> Data? {
    let rep = NSBitmapImageRep(cgImage: image)
    return rep.representation(using: .png, properties: [:])
}

func captureWithScreenCaptureKit(windowId: Int, scale: Double, rect: CGRect) -> (CGImage?, String?) {
    var result: CGImage?
    var failure: String?
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let w = content.windows.first(where: { Int($0.windowID) == windowId }) else {
                failure = "the window is not in the shareable window list"
                sem.signal(); return
            }
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let cfg = SCStreamConfiguration()
            cfg.width = max(1, Int((rect.width * scale).rounded()))
            cfg.height = max(1, Int((rect.height * scale).rounded()))
            cfg.showsCursor = false
            cfg.capturesAudio = false
            result = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        } catch {
            failure = "\(error)"
        }
        sem.signal()
    }
    if sem.wait(timeout: .now() + 12) == .timedOut { return (nil, "screen capture timed out") }
    return (result, failure)
}

func captureReply(_ req: Json) throws -> Json {
    guard let windowId = intOf(req["hwnd"]), let dir = req["dir"] as? String else {
        throw HelperError(code: "bad_request", message: "hwnd and dir are required")
    }
    let entry = try entryFor(windowId: windowId)
    if !CGPreflightScreenCaptureAccess() {
        let name = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? "Namzu Helper"
        throw HelperError(
            code: "screen_capture_denied",
            message: "Screen Recording is off for \(name). Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on \"\(name)\", then try again.")
    }
    let scale = mainScale()
    let path = (dir as NSString).appendingPathComponent("w\(windowId)-\(UUID().uuidString.prefix(8)).png")
    let (image, why) = captureWithScreenCaptureKit(windowId: windowId, scale: scale, rect: entry.bounds)
    if let image = image, let data = pngData(image) {
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        return ["path": path, "width": image.width, "height": image.height, "via": "screencapturekit"]
    }
    // The built-in tool, started from this app, is covered by this app's permission too.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", "-o", "-l", String(windowId), path]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus == 0, let data = FileManager.default.contents(atPath: path), data.count > 24 {
        let w = Int(UInt32(bigEndian: data.subdata(in: 16..<20).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
        let h = Int(UInt32(bigEndian: data.subdata(in: 20..<24).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
        return ["path": path, "width": w, "height": h, "via": "screencapture"]
    }
    throw HelperError(code: "capture_failed", message: "could not capture the window: \(why ?? "unknown")")
}

// MARK: - Change events

struct ChangeEvent {
    let seq: Int
    let kind: String
    let pid: pid_t
    let at: Double
}

final class EventLog {
    let cond = NSCondition()
    private(set) var counter = 0
    private var events: [ChangeEvent] = []
    var observers: [pid_t: AXObserver] = [:]
    var known: [Int: Set<Int>] = [:]  // window id -> window ids of the app when armed

    func record(kind: String, pid: pid_t) {
        cond.lock()
        counter += 1
        events.append(ChangeEvent(seq: counter, kind: kind, pid: pid, at: nowMs()))
        if events.count > 5000 { events.removeFirst(2000) }
        cond.broadcast()
        cond.unlock()
    }

    func current() -> Int {
        cond.lock(); defer { cond.unlock() }
        return counter
    }

    /// Events of one process after `since`, of the wanted kinds; the lock must be held.
    func matching(pid: pid_t, since: Int, kinds: Set<String>) -> [ChangeEvent] {
        events.filter { $0.seq > since && $0.pid == pid && kinds.contains($0.kind) }
    }
}

let eventLog = EventLog()

let structureNotes = [
    "AXCreated", "AXUIElementDestroyed", "AXWindowCreated", "AXMenuOpened", "AXMenuClosed",
    "AXRowCountChanged", "AXLayoutChanged", "AXSelectedChildrenChanged", "AXSelectedRowsChanged",
    "AXRowExpanded", "AXRowCollapsed", "AXSheetCreated", "AXDrawerCreated",
]
let propertyNotes = [
    "AXValueChanged", "AXTitleChanged", "AXFocusedUIElementChanged", "AXSelectedTextChanged",
    "AXFocusedWindowChanged", "AXMainWindowChanged", "AXApplicationActivated", "AXApplicationDeactivated",
]
let locationNotes = ["AXMoved", "AXResized"]

let observerCallback: AXObserverCallback = { _, _, notification, refcon in
    guard let refcon = refcon else { return }
    let pid = pid_t(Int(bitPattern: refcon))
    let name = notification as String
    let kind = structureNotes.contains(name) ? "structure" : (locationNotes.contains(name) ? "location" : "property")
    eventLog.record(kind: kind, pid: pid)
}

func armObserver(pid: pid_t, windowElement: AXUIElement?) {
    eventLog.cond.lock()
    let existing = eventLog.observers[pid]
    eventLog.cond.unlock()
    if existing != nil { return }
    var obs: AXObserver?
    guard AXObserverCreate(pid, observerCallback, &obs) == .success, let observer = obs else { return }
    let refcon = UnsafeMutableRawPointer(bitPattern: Int(pid))
    let app = appElement(pid)
    for name in structureNotes + propertyNotes + locationNotes {
        AXObserverAddNotification(observer, app, name as CFString, refcon)
        if let w = windowElement { AXObserverAddNotification(observer, w, name as CFString, refcon) }
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    eventLog.cond.lock()
    eventLog.observers[pid] = observer
    eventLog.cond.unlock()
}

func windowIdsOf(pid: pid_t) -> Set<Int> {
    Set(listWindowEntries().filter { $0.pid == pid }.map { $0.id })
}

func seqReply(_ req: Json) throws -> Json {
    if let windowId = intOf(req["hwnd"]) {
        let entry = try entryFor(windowId: windowId)
        try requireAccessibility(pid: entry.pid)
        armObserver(pid: entry.pid, windowElement: axWindowElement(windowId: windowId, pid: entry.pid))
        eventLog.cond.lock()
        eventLog.known[windowId] = windowIdsOf(pid: entry.pid)
        eventLog.cond.unlock()
    }
    return ["seq": eventLog.current()]
}

func waitReply(_ req: Json) throws -> Json {
    guard let windowId = intOf(req["hwnd"]) else { throw HelperError(code: "bad_request", message: "hwnd is required") }
    let entry = try entryFor(windowId: windowId)
    try requireAccessibility(pid: entry.pid)
    let pid = entry.pid
    armObserver(pid: pid, windowElement: axWindowElement(windowId: windowId, pid: pid))
    let timeoutMs = Double(min(intOf(req["timeoutMs"]) ?? 2000, 10_000))
    let quietMs = Double(intOf(req["quietMs"]) ?? 120)
    var kinds: Set<String> = ["structure", "property", "location"]
    if let k = req["kinds"] as? [String], !k.isEmpty { kinds = Set(k) }
    let started = nowMs()
    eventLog.cond.lock()
    let since = intOf(req["since"]) ?? eventLog.counter
    if eventLog.known[windowId] == nil { eventLog.known[windowId] = windowIdsOf(pid: pid) }
    let knownBefore = eventLog.known[windowId] ?? []
    var first: ChangeEvent?
    var last: ChangeEvent?
    var count = 0
    var settled = false
    let deadline = Date().addingTimeInterval(timeoutMs / 1000)
    while true {
        let found = eventLog.matching(pid: pid, since: since, kinds: kinds)
        if let f = found.first, let l = found.last {
            first = f; last = l; count = found.count
            let quietFor = nowMs() - l.at
            if quietFor >= quietMs { settled = true; break }
            let remaining = min(deadline.timeIntervalSinceNow, (quietMs - quietFor) / 1000)
            if remaining <= 0 { break }
            _ = eventLog.cond.wait(until: Date().addingTimeInterval(remaining))
        } else {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { break }
            _ = eventLog.cond.wait(until: Date().addingTimeInterval(remaining))
        }
        if deadline.timeIntervalSinceNow <= 0 {
            let found2 = eventLog.matching(pid: pid, since: since, kinds: kinds)
            if let f = found2.first, let l = found2.last { first = f; last = l; count = found2.count }
            break
        }
    }
    eventLog.cond.unlock()
    let elapsed = nowMs() - started
    if let f = first, let l = last {
        let now = windowIdsOf(pid: pid)
        let fresh = now.subtracting(knownBefore).sorted()
        return [
            "changed": true, "settled": settled, "firstEventMs": Int(f.at - started), "settledMs": Int(max(0, l.at - started)),
            "events": count, "newWindows": fresh,
        ]
    }
    return ["changed": false, "timedOut": true, "settledMs": Int(elapsed)]
}

// MARK: - Self check

func selfcheckReply() -> Json {
    var checks: [Json] = []
    func add(_ name: String, _ ok: Bool, _ detail: String = "") {
        checks.append(["name": name, "ok": ok, "detail": detail])
    }
    add("accessibility_trusted", AXIsProcessTrusted(), AXIsProcessTrusted() ? "" : "turn on Namzu Helper in Privacy & Security > Accessibility")
    add("screen_capture_allowed", CGPreflightScreenCaptureAccess(), "")
    let wins = listWindowEntries()
    add("cgwindowlist", !wins.isEmpty, "\(wins.count) windows")
    let titled = wins.filter { !$0.title.isEmpty }.count
    add("window_titles", titled > 0 || wins.isEmpty, "\(titled) of \(wins.count) windows have a title (titles of other apps need Screen Recording)")
    if let f = frontmostPid() {
        let app = appElement(f)
        var role: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &role)
        add("ax_read_frontmost", err == .success, err == .success ? "" : axErrorText(err))
    }
    var obs: AXObserver?
    let oerr = AXObserverCreate(ProcessInfo.processInfo.processIdentifier, observerCallback, &obs)
    add("ax_observer", oerr == .success, "")
    add("main_display_scale", mainScale() >= 1, "\(mainScale())")
    return [
        "checks": checks, "pid": Int(ProcessInfo.processInfo.processIdentifier), "build": buildId,
        "path": Bundle.main.bundlePath, "os": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
}


// MARK: - Self test on a window of the helper's own

final class DemoState: NSObject {
    var window: NSWindow?
    let status = NSTextField(labelWithString: "idle")
    let field = NSTextField(string: "")
    @objc func pressed(_ sender: Any?) { status.stringValue = "pressed" }
}

let demo = DemoState()

func ensureDemoWindow() -> Int? {
    onMain {
        if demo.window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 220, y: 220, width: 420, height: 240),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Namzu Helper Demo"
            w.isReleasedWhenClosed = false
            let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 240))
            let button = NSButton(title: "Press me", target: demo, action: #selector(DemoState.pressed(_:)))
            button.frame = NSRect(x: 20, y: 180, width: 120, height: 30)
            button.setAccessibilityIdentifier("demo.press")
            let check = NSButton(checkboxWithTitle: "Check me", target: nil, action: nil)
            check.frame = NSRect(x: 20, y: 140, width: 160, height: 24)
            check.setAccessibilityIdentifier("demo.check")
            demo.field.frame = NSRect(x: 20, y: 100, width: 300, height: 24)
            demo.field.isEditable = true
            demo.field.setAccessibilityIdentifier("demo.field")
            demo.status.frame = NSRect(x: 20, y: 60, width: 300, height: 24)
            for v in [button, check, demo.field, demo.status] as [NSView] { content.addSubview(v) }
            w.contentView = content
            let menu = NSMenu()
            let top = NSMenuItem(title: "Format", action: nil, keyEquivalent: "")
            let sub = NSMenu(title: "Format")
            sub.addItem(NSMenuItem(title: "Make Plain Text", action: nil, keyEquivalent: ""))
            top.submenu = sub
            menu.addItem(top)
            NSApp.mainMenu = menu
            demo.window = w
        }
        demo.window?.orderFrontRegardless()
    }
    for _ in 0..<60 {
        if let e = listWindowEntries().first(where: { $0.pid == ProcessInfo.processInfo.processIdentifier && $0.title == "Namzu Helper Demo" }) {
            return e.id
        }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return nil
}

func closeDemoWindow() {
    onMain { demo.window?.orderOut(nil) }
}

func selftestReply() -> Json {
    var results: [Json] = []
    func check(_ name: String, _ ok: Bool, _ detail: String = "") {
        results.append(["name": name, "ok": ok, "detail": detail])
    }
    guard let wid = ensureDemoWindow() else {
        check("demo_window", false, "the demo window did not appear on screen (is there a desktop session?)")
        return ["checks": results]
    }
    check("demo_window", true, "window \(wid)")
    func read() throws -> [Json] {
        let r = try snapshotReply(["hwnd": wid, "maxNodes": 300, "allowChromium": true])
        return (r["nodes"] as? [Json]) ?? []
    }
    func find(_ nodes: [Json], role: String, name: String? = nil, id: String? = nil) -> Json? {
        nodes.first { n in
            (n["role"] as? String) == role && (name == nil || (n["name"] as? String) == name)
                && (id == nil || (n["automationId"] as? String) == id)
        }
    }
    do {
        let nodes = try read()
        check("snapshot_reads_controls", nodes.count >= 5, "\(nodes.count) nodes")
        let button = find(nodes, role: "AXButton", id: "demo.press")
        let check1 = find(nodes, role: "AXCheckBox", id: "demo.check")
        let field = find(nodes, role: "AXTextField", id: "demo.field")
        check("finds_button_checkbox_field", button != nil && check1 != nil && field != nil,
              "button \(button != nil) checkbox \(check1 != nil) field \(field != nil)")
        check("button_offers_invoke", ((button?["actions"] as? [String]) ?? []).contains("invoke"), "\(button?["actions"] ?? "none")")
        check("checkbox_reads_toggle", (check1?["toggle"] as? String) == "off", "\(check1?["toggle"] ?? "none")")
        check("field_offers_value", ((field?["actions"] as? [String]) ?? []).contains("value"), "\(field?["actions"] ?? "none")")
        let menuBar = nodes.contains { ($0["role"] as? String) == "AXMenuBar" }
        let menuItem = find(nodes, role: "AXMenuBarItem", name: "Format")
        check("menu_bar_in_window_tree", menuBar && menuItem != nil, "menu bar \(menuBar) Format item \(menuItem != nil) childCount \(menuItem?["childCount"] ?? "none")")

        if let button = button, let fp = button["fp"] as? Json {
            let r = try actReply(["hwnd": wid, "fingerprint": fp, "action": "invoke"])
            check("act_invoke_button", (r["done"] as? Bool) == true, "\(r)")
            let after = try read()
            check("button_press_visible_in_tree", find(after, role: "AXStaticText", name: "pressed") != nil, "status label now reads pressed")
            let again = find(after, role: "AXButton", id: "demo.press")
            let same = ((again?["fp"] as? Json)?["runtimeId"] as? String) == (fp["runtimeId"] as? String)
            check("runtime_id_survives_snapshot", same, "\(fp["runtimeId"] ?? "")")
            var stale = fp
            stale["runtimeId"] = "0:0"
            let found = try resolveReply(["hwnd": wid, "fingerprint": stale])
            check("resolve_by_automation_id", (found["found"] as? Bool) == true && (found["via"] as? String) == "automationId", "\(found)")
            var renamed = fp
            renamed["runtimeId"] = "0:0"
            renamed["automationId"] = ""
            let byName = try resolveReply(["hwnd": wid, "fingerprint": renamed])
            check("resolve_by_name", (byName["found"] as? Bool) == true && (byName["via"] as? String) == "name", "\(byName)")
        }
        if let c = check1, let fp = c["fp"] as? Json {
            let seq0 = try seqReply(["hwnd": wid])
            let r = try actReply(["hwnd": wid, "fingerprint": fp, "action": "toggle"])
            check("act_toggle_checkbox", (r["done"] as? Bool) == true && (r["verified"] as? Bool) == true, "\(r)")
            let waited = try waitReply(["hwnd": wid, "since": seq0["seq"] ?? 0, "timeoutMs": 1500, "quietMs": 100])
            check("wait_change_sees_toggle", (waited["changed"] as? Bool) == true, "\(waited)")
        }
        if let f = field, let fp = f["fp"] as? Json {
            let r = try actReply(["hwnd": wid, "fingerprint": fp, "action": "set_value", "value": "hello namzu"])
            check("act_set_value", (r["done"] as? Bool) == true && (r["verified"] as? Bool) == true, "\(r)")
        }
        if let item = menuItem, let fp = item["fp"] as? Json {
            let r = try snapshotReply(["hwnd": wid, "root": fp, "maxNodes": 50, "maxDepth": 3])
            let sub = ((r["nodes"] as? [Json]) ?? []).contains { ($0["name"] as? String) == "Make Plain Text" }
            check("menu_item_opens_by_root", sub, "nodes \((r["nodes"] as? [Json])?.count ?? 0)")
        }
    } catch let e as HelperError {
        check("selftest_aborted", false, "\(e.code): \(e.message)")
    } catch {
        check("selftest_aborted", false, "\(error)")
    }
    closeDemoWindow()
    return ["checks": results]
}

// MARK: - Server

func dispatch(_ cmd: String, _ req: Json) throws -> Json {
    switch cmd {
    case "permissions": return permissionsReply(prompt: (req["prompt"] as? Bool) == true)
    case "windows": return windowsReply()
    case "displays": return displaysReply()
    case "snapshot": return try snapshotReply(req)
    case "seq": return try seqReply(req)
    case "wait_change": return try waitReply(req)
    case "identity": return try identityReply(req)
    case "resolve": return try resolveReply(req)
    case "act": return try actReply(req)
    case "focus": return try focusReply(req)
    case "scroll": return try scrollReply(req)
    case "click": return try clickReply(req)
    case "type": return try typeReply(req)
    case "key": return try keyReply(req)
    case "capture_window": return try captureReply(req)
    case "selfcheck": return selfcheckReply()
    case "selftest": return selftestReply()
    default: throw HelperError(code: "unknown_command", message: "unknown command \(cmd)")
    }
}

final class Connection {
    let fd: Int32
    private let writeLock = NSLock()
    init(_ fd: Int32) { self.fd = fd }

    func send(_ obj: Json) {
        var obj = obj
        if !JSONSerialization.isValidJSONObject(obj) {
            obj = ["id": obj["id"] ?? 0, "ok": false, "code": "bad_reply", "message": "the helper could not encode its own answer"]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        var bytes = [UInt8](data)
        bytes.append(10)
        writeLock.lock(); defer { writeLock.unlock() }
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            if n <= 0 { return }
            off += n
        }
    }

    func serve() {
        send(["ok": true, "hello": true, "version": protocolVersion, "helper": "macos-ax", "pid": Int(getpid()), "build": buildId])
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        let queue = DispatchQueue(label: "namzu.requests", attributes: .concurrent)
        readLoop: while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 10) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? Json else { continue }
                let id = obj["id"] ?? 0
                let cmd = (obj["cmd"] as? String) ?? ""
                if cmd == "quit" { break readLoop }
                if cmd == "shutdown" {
                    send(["id": id, "ok": true])
                    exit(0)
                }
                queue.async {
                    var reply: Json
                    do {
                        reply = try dispatch(cmd, obj)
                        reply["ok"] = true
                    } catch let e as HelperError {
                        reply = ["ok": false, "code": e.code, "message": e.message]
                    } catch {
                        reply = ["ok": false, "code": "error", "message": "\(error)"]
                    }
                    reply["id"] = id
                    self.send(reply)
                }
            }
        }
        close(fd)
    }
}

var activeConnections = 0
var lastActivity = Date()
let connectionLock = NSLock()

func startServer() {
    guard !socketPath.isEmpty else {
        FileHandle.standardError.write(Data("namzu-helper: --socket <path> is required\n".utf8))
        exit(64)
    }
    let dir = (socketPath as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(dir, 0o700)
    unlink(socketPath)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
        FileHandle.standardError.write(Data("namzu-helper: socket path too long\n".utf8))
        exit(64)
    }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in pathBytes.enumerated() { raw[i] = b }
        raw[pathBytes.count] = 0
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
    }
    guard bound == 0 else {
        FileHandle.standardError.write(Data("namzu-helper: cannot bind \(socketPath)\n".utf8))
        exit(65)
    }
    chmod(socketPath, 0o600)
    listen(fd, 8)
    Thread.detachNewThread {
        while true {
            let client = accept(fd, nil, nil)
            if client < 0 { continue }
            var uid: uid_t = 0
            var gid: gid_t = 0
            if getpeereid(client, &uid, &gid) != 0 || uid != getuid() { close(client); continue }
            connectionLock.lock(); activeConnections += 1; lastActivity = Date(); connectionLock.unlock()
            Thread.detachNewThread {
                Connection(client).serve()
                connectionLock.lock(); activeConnections -= 1; lastActivity = Date(); connectionLock.unlock()
            }
        }
    }
    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
        connectionLock.lock()
        let idle = activeConnections == 0 && Date().timeIntervalSince(lastActivity) > idleExitSeconds
        connectionLock.unlock()
        if idle { unlink(socketPath); exit(0) }
    }
}

// MARK: - Main

if CommandLine.arguments.contains("--selfcheck") {
    let r = selfcheckReply()
    if let d = try? JSONSerialization.data(withJSONObject: r, options: [.prettyPrinted]), let s = String(data: d, encoding: .utf8) { print(s) }
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in unlink(socketPath); exit(0) }
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
startServer()
application.run()
