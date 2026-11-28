//! Reading a window's controls into a snapshot, without knowing where the
//! controls come from.
//!
//! The helper reads UI Automation; a test reads a list in memory. Both give
//! [`Source`] a way to describe one control and list its children, and
//! [`walk`] and [`skeleton`] turn that into the nodes, the identities and the
//! counts a `snapshot` reply carries. The limits (how many nodes, how deep,
//! what `childCount` means) are the ones the PowerShell helper had, so the
//! two backends answer the same question the same way.

use crate::fingerprint::{self, Identity, IdentityInput};
use crate::protocol::{Action, ExpandState, Node, Rect, ToggleState};

/// Longest name or value kept in a node, in characters.
pub const TEXT_LIMIT: usize = 120;

/// The name UI Automation gives a control type (`Button`, `Edit`, `Pane`, ...),
/// from its numeric id; a number that names no type reads as `Custom`.
pub fn control_type_name(id: i32) -> &'static str {
    const NAMES: [&str; 41] = [
        "Button",
        "Calendar",
        "CheckBox",
        "ComboBox",
        "Edit",
        "Hyperlink",
        "Image",
        "ListItem",
        "List",
        "Menu",
        "MenuBar",
        "MenuItem",
        "ProgressBar",
        "RadioButton",
        "ScrollBar",
        "Slider",
        "Spinner",
        "StatusBar",
        "Tab",
        "TabItem",
        "Text",
        "ToolBar",
        "ToolTip",
        "Tree",
        "TreeItem",
        "Custom",
        "Group",
        "Thumb",
        "DataGrid",
        "DataItem",
        "Document",
        "SplitButton",
        "Window",
        "Pane",
        "Header",
        "HeaderItem",
        "Table",
        "TitleBar",
        "Separator",
        "SemanticZoom",
        "AppBar",
    ];
    id.checked_sub(50_000)
        .and_then(|i| usize::try_from(i).ok())
        .and_then(|i| NAMES.get(i).copied())
        .unwrap_or("Custom")
}

/// What the platform said about one control.
#[derive(Debug, Clone, PartialEq)]
pub struct RawNode {
    pub role: String,
    pub name: String,
    pub automation_id: String,
    pub class_name: String,
    pub bounds: Rect,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub runtime_id: Vec<i32>,
    pub actions: Vec<Action>,
    /// None for a control that has no value, or whose value is a password.
    pub value: Option<String>,
    pub toggle: Option<ToggleState>,
    pub expand: Option<ExpandState>,
    pub selected: Option<bool>,
}

impl RawNode {
    /// A control with nothing but a kind and a name, for tests and defaults.
    pub fn plain(role: &str, name: &str) -> RawNode {
        RawNode {
            role: role.to_owned(),
            name: name.to_owned(),
            automation_id: String::new(),
            class_name: String::new(),
            bounds: Rect {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            },
            enabled: true,
            offscreen: false,
            focused: false,
            runtime_id: Vec::new(),
            actions: Vec::new(),
            value: None,
            toggle: None,
            expand: None,
            selected: None,
        }
    }
}

/// Where controls come from.
pub trait Source {
    type Handle: Clone;
    /// What the platform says about `h`.
    fn node(&self, h: &Self::Handle) -> RawNode;
    /// The children of `h` in reading order; `None` when they cannot be listed.
    fn children(&self, h: &Self::Handle) -> Option<Vec<Self::Handle>>;
    /// `h` read again so that its own children are available in one call
    /// (UI Automation: a cache request rooted at it). Defaults to `h`.
    fn refresh(&self, h: &Self::Handle) -> Self::Handle {
        h.clone()
    }
}

/// One read of a window.
#[derive(Debug, Clone)]
pub struct Walked<H> {
    /// Wire nodes; `reference` is empty until [`Walked::set_revision`].
    pub nodes: Vec<Node>,
    /// The handle of each node, same order.
    pub handles: Vec<H>,
    /// The identity of each node, same order.
    pub identities: Vec<Identity>,
    /// Controls in the window, listed or not.
    pub total: u32,
    pub truncated: bool,
}

impl<H> Walked<H> {
    /// Names the read: every node's `ref` becomes `r<revision>.<index>`.
    pub fn set_revision(&mut self, revision: u64) {
        for n in &mut self.nodes {
            n.reference = crate::refs::format_ref(revision, n.index);
        }
    }
}

fn clip(s: &str) -> String {
    s.chars().take(TEXT_LIMIT).collect()
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| clip(s))
}

fn wire_node(raw: &RawNode, index: u32, parent: i32, depth: u32) -> Node {
    Node {
        index,
        reference: String::new(),
        parent,
        depth,
        role: raw.role.clone(),
        name: non_empty(&raw.name),
        automation_id: (!raw.automation_id.is_empty()).then(|| raw.automation_id.clone()),
        class_name: (!raw.class_name.is_empty()).then(|| raw.class_name.clone()),
        bounds: raw.bounds,
        enabled: raw.enabled,
        offscreen: raw.offscreen,
        focused: raw.focused,
        actions: raw.actions.clone(),
        value: raw.value.as_deref().map(clip),
        toggle: raw.toggle,
        expand: raw.expand,
        selected: raw.selected,
        child_count: None,
    }
}

struct Acc<H> {
    nodes: Vec<Node>,
    raws: Vec<RawNode>,
    handles: Vec<H>,
    total: u32,
    truncated: bool,
    max: usize,
}

impl<H> Acc<H> {
    fn new(max: u32) -> Acc<H> {
        Acc {
            nodes: Vec::new(),
            raws: Vec::new(),
            handles: Vec::new(),
            total: 0,
            truncated: false,
            max: max as usize,
        }
    }

    fn push(&mut self, raw: RawNode, handle: H, parent: i32, depth: u32) -> usize {
        let index = self.nodes.len();
        self.nodes
            .push(wire_node(&raw, index as u32, parent, depth));
        self.raws.push(raw);
        self.handles.push(handle);
        index
    }

    fn finish(self) -> Walked<H> {
        let inputs: Vec<IdentityInput<'_>> = self
            .raws
            .iter()
            .zip(&self.nodes)
            .map(|(raw, node)| IdentityInput {
                parent: node.parent,
                role: &raw.role,
                name: &raw.name,
                automation_id: &raw.automation_id,
                runtime_id: &raw.runtime_id,
            })
            .collect();
        // A depth-first walk lists a parent before its children, which is the
        // one thing `assign` asks; a list that breaks it has no identities.
        let identities = fingerprint::assign(&inputs).unwrap_or_default();
        Walked {
            nodes: self.nodes,
            handles: self.handles,
            identities,
            total: self.total,
            truncated: self.truncated,
        }
    }
}

fn count_all<S: Source>(src: &S, h: &S::Handle) -> u32 {
    let mut n = 1;
    if let Some(kids) = src.children(h) {
        for k in &kids {
            n += count_all(src, k);
        }
    }
    n
}

fn walk_into<S: Source>(
    src: &S,
    h: &S::Handle,
    parent: i32,
    depth: u32,
    max_depth: u32,
    acc: &mut Acc<S::Handle>,
) {
    acc.total += 1;
    if acc.nodes.len() >= acc.max || depth > max_depth {
        acc.truncated = true;
        if let Some(kids) = src.children(h) {
            for k in &kids {
                acc.total += count_all(src, k);
            }
        }
        return;
    }
    let index = acc.push(src.node(h), h.clone(), parent, depth);
    let Some(kids) = src.children(h) else {
        return;
    };
    let before = acc.nodes.len();
    for k in &kids {
        walk_into(src, k, index as i32, depth + 1, max_depth, acc);
    }
    let added = acc.nodes.len() - before;
    if added < kids.len() || depth + 1 > max_depth {
        acc.nodes[index].child_count = Some(kids.len() as u32);
    }
}

/// The controls under `root`, depth first, at most `max_nodes` of them and
/// `max_depth` levels down. Controls past a limit are counted in `total`, and
/// a container whose children were not all listed carries `childCount`.
pub fn walk<S: Source>(
    src: &S,
    root: &S::Handle,
    max_nodes: u32,
    max_depth: u32,
) -> Walked<S::Handle> {
    let mut acc = Acc::new(max_nodes);
    walk_into(src, root, -1, 0, max_depth, &mut acc);
    acc.finish()
}

/// The shallow read: the window, its children and theirs, with `childCount`
/// on the window and on each child that has children.
pub fn skeleton<S: Source>(src: &S, root: &S::Handle, max_nodes: u32) -> Walked<S::Handle> {
    let mut acc = Acc::new(max_nodes);
    let top = src.refresh(root);
    acc.total = 1;
    let root_index = acc.push(src.node(&top), top.clone(), -1, 0);
    let kids = src.children(&top).unwrap_or_default();
    if !kids.is_empty() {
        acc.nodes[root_index].child_count = Some(kids.len() as u32);
    }
    for k in &kids {
        if acc.nodes.len() >= acc.max {
            acc.truncated = true;
            acc.total += 1;
            continue;
        }
        let kc = src.refresh(k);
        acc.total += 1;
        let ki = acc.push(src.node(&kc), kc.clone(), root_index as i32, 1);
        let grand = src.children(&kc).unwrap_or_default();
        if !grand.is_empty() {
            acc.nodes[ki].child_count = Some(grand.len() as u32);
            for g in &grand {
                acc.total += 1;
                if acc.nodes.len() >= acc.max {
                    acc.truncated = true;
                    continue;
                }
                acc.push(src.node(g), g.clone(), ki as i32, 2);
            }
        }
    }
    acc.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree in memory: node `i` has `kids[i]` for children.
    struct Fake {
        raws: Vec<RawNode>,
        kids: Vec<Vec<usize>>,
        /// Nodes whose children cannot be listed.
        opaque: Vec<usize>,
    }

    impl Fake {
        fn new(spec: &[(&str, &str, &[usize])]) -> Fake {
            Fake {
                raws: spec.iter().map(|(r, n, _)| RawNode::plain(r, n)).collect(),
                kids: spec.iter().map(|(_, _, k)| k.to_vec()).collect(),
                opaque: Vec::new(),
            }
        }
    }

    impl Source for Fake {
        type Handle = usize;
        fn node(&self, h: &usize) -> RawNode {
            self.raws[*h].clone()
        }
        fn children(&self, h: &usize) -> Option<Vec<usize>> {
            if self.opaque.contains(h) {
                None
            } else {
                Some(self.kids[*h].clone())
            }
        }
    }

    fn calculator() -> Fake {
        // 0 Window; 1 Pane (2 Button 7, 3 Button 8); 4 Text
        Fake::new(&[
            ("Window", "Calculator", &[1, 4]),
            ("Pane", "", &[2, 3]),
            ("Button", "7", &[]),
            ("Button", "8", &[]),
            ("Text", "Display is 0", &[]),
        ])
    }

    #[test]
    fn a_whole_window_is_listed_depth_first_with_parents_and_depths() {
        let w = walk(&calculator(), &0, 400, 12);
        let shape: Vec<(i32, u32, &str)> = w
            .nodes
            .iter()
            .map(|n| (n.parent, n.depth, n.role.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                (-1, 0, "Window"),
                (0, 1, "Pane"),
                (1, 2, "Button"),
                (1, 2, "Button"),
                (0, 1, "Text")
            ]
        );
        assert_eq!((w.total, w.truncated), (5, false));
        assert!(w.nodes.iter().all(|n| n.child_count.is_none()));
        assert_eq!(w.handles, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn identities_follow_the_nodes() {
        let w = walk(&calculator(), &0, 400, 12);
        assert_eq!(w.identities.len(), 5);
        assert!(w.identities[3].parent_path.starts_with("Window:"));
        assert_eq!(w.identities[2].ordinal, 0);
        assert_eq!(
            w.identities[3].ordinal, 0,
            "ordinal counts a name, and 7 is not 8"
        );
    }

    #[test]
    fn too_many_nodes_truncates_counts_the_rest_and_marks_the_container() {
        let w = walk(&calculator(), &0, 3, 12);
        assert_eq!(w.nodes.len(), 3);
        assert!(w.truncated);
        assert_eq!(w.total, 5, "controls past the limit are still counted");
        // The pane lists one of its two buttons, so it says how many it has.
        assert_eq!(w.nodes[1].child_count, Some(2));
        // The window listed fewer than all its descendants but at least as many as its children.
        assert_eq!(w.nodes[0].child_count, None);
    }

    #[test]
    fn too_deep_truncates_and_names_the_children_that_were_not_listed() {
        let w = walk(&calculator(), &0, 400, 1);
        assert_eq!(w.nodes.len(), 3);
        assert!(w.truncated);
        assert_eq!(w.total, 5);
        assert_eq!(w.nodes[1].child_count, Some(2));
    }

    #[test]
    fn a_control_whose_children_cannot_be_listed_is_a_leaf_without_a_count() {
        let mut f = calculator();
        f.opaque.push(1);
        let w = walk(&f, &0, 400, 12);
        assert_eq!(w.nodes.len(), 3);
        assert_eq!(w.nodes[1].child_count, None);
        assert!(!w.truncated);
    }

    #[test]
    fn the_skeleton_is_the_window_its_children_and_theirs() {
        let w = skeleton(&calculator(), &0, 400);
        let shape: Vec<(i32, u32, Option<u32>)> = w
            .nodes
            .iter()
            .map(|n| (n.parent, n.depth, n.child_count))
            .collect();
        assert_eq!(
            shape,
            vec![
                (-1, 0, Some(2)),
                (0, 1, Some(2)),
                (1, 2, None),
                (1, 2, None),
                (0, 1, None)
            ]
        );
        assert_eq!(w.total, 5);
        assert!(!w.truncated);
    }

    #[test]
    fn the_skeleton_stops_at_the_node_limit() {
        let w = skeleton(&calculator(), &0, 2);
        assert_eq!(w.nodes.len(), 2);
        assert!(w.truncated);
        assert_eq!(w.total, 5);
    }

    #[test]
    fn long_names_are_clipped_on_the_wire_but_hashed_whole() {
        let long = "x".repeat(300);
        let f = Fake::new(&[("Window", &long, &[])]);
        let w = walk(&f, &0, 10, 3);
        assert_eq!(
            w.nodes[0].name.as_ref().unwrap().chars().count(),
            TEXT_LIMIT
        );
        assert_eq!(w.identities[0].name_hash, fingerprint::name_hash(&long));
    }

    #[test]
    fn control_types_have_their_names() {
        assert_eq!(control_type_name(50_000), "Button");
        assert_eq!(control_type_name(50_032), "Window");
        assert_eq!(control_type_name(50_033), "Pane");
        assert_eq!(control_type_name(50_040), "AppBar");
        assert_eq!(control_type_name(50_041), "Custom");
        assert_eq!(control_type_name(-1), "Custom");
        assert_eq!(control_type_name(0), "Custom");
    }

    #[test]
    fn refs_name_the_read() {
        let mut w = walk(&calculator(), &0, 400, 12);
        w.set_revision(7);
        assert_eq!(w.nodes[3].reference, "r7.3");
    }
}
