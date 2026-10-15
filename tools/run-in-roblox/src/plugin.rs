//! Renders the plugin that Studio loads for a run: a `Script` (the relay, from
//! `plugin_main_template.lua`) with a child `ModuleScript` named `Main` that wraps the user's
//! script in `return function() ... end`. Written as Roblox XML (`.rbxmx`) from a string
//! template, so no rbx-dom dependency is needed.

static PLUGIN_TEMPLATE: &str = include_str!("plugin_main_template.lua");

pub const PLUGIN_SCRIPT_NAME: &str = "run-in-roblox-plugin";

/// Wrap `s` in CDATA. A literal `]]>` inside the text would terminate the section early, so it is
/// split across two adjacent CDATA sections, which XML parsers concatenate back into the same text.
pub fn cdata(s: &str) -> String {
    format!("<![CDATA[{}]]>", s.replace("]]>", "]]]]><![CDATA[>"))
}

fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The relay script source for a given port/server id. `hold` disables the Main script and keeps
/// relaying output until Studio is killed.
pub fn relay_source(port: u16, server_id: &str, hold: bool) -> String {
    PLUGIN_TEMPLATE
        .replace("{{PORT}}", &port.to_string())
        .replace("{{SERVER_ID}}", server_id)
        .replace("{{HOLD}}", if hold { "true" } else { "false" })
}

/// Render the complete `.rbxmx` document.
pub fn render_plugin_rbxmx(port: u16, server_id: &str, lua_main_body: &str, hold: bool) -> String {
    let relay = relay_source(port, server_id, hold);
    let main = format!("return function()\n{}\nend", lua_main_body);
    format!(
        concat!(
            "<roblox xmlns:xmime=\"http://www.w3.org/2005/05/xmlmime\" ",
            "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" ",
            "xsi:noNamespaceSchemaLocation=\"http://www.roblox.com/roblox.xsd\" version=\"4\">\n",
            "  <Item class=\"Script\" referent=\"RBX0\">\n",
            "    <Properties>\n",
            "      <string name=\"Name\">{name}</string>\n",
            "      <ProtectedString name=\"Source\">{relay}</ProtectedString>\n",
            "    </Properties>\n",
            "    <Item class=\"ModuleScript\" referent=\"RBX1\">\n",
            "      <Properties>\n",
            "        <string name=\"Name\">Main</string>\n",
            "        <ProtectedString name=\"Source\">{main}</ProtectedString>\n",
            "      </Properties>\n",
            "    </Item>\n",
            "  </Item>\n",
            "</roblox>\n"
        ),
        name = xml_text(PLUGIN_SCRIPT_NAME),
        relay = cdata(&relay),
        main = cdata(&main),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode the text of adjacent CDATA sections (what an XML parser yields).
    fn decode_cdata(s: &str) -> String {
        s.replace("]]><![CDATA[", "")
            .trim_start_matches("<![CDATA[")
            .trim_end_matches("]]>")
            .to_string()
    }

    #[test]
    fn substitutes_placeholders() {
        let src = relay_source(50312, "run-in-roblox-abc", false);
        assert!(src.contains("local PORT = \"50312\""));
        assert!(src.contains("local SERVER_ID = \"run-in-roblox-abc\""));
        assert!(src.contains("local HOLD = false"));
        assert!(!src.contains("{{"));
        assert!(src.contains("http://127.0.0.1:%s"));
        assert!(!src.contains("localhost"));
        assert!(src.contains("task.wait("));
        assert!(!src.contains("\nwait("));
    }

    #[test]
    fn renders_two_items() {
        let xml = render_plugin_rbxmx(1234, "sid", "print('hi')", false);
        assert_eq!(xml.matches("<Item class=\"Script\" referent=\"RBX0\">").count(), 1);
        assert_eq!(xml.matches("<Item class=\"ModuleScript\" referent=\"RBX1\">").count(), 1);
        assert!(xml.contains("<string name=\"Name\">run-in-roblox-plugin</string>"));
        assert!(xml.contains("<string name=\"Name\">Main</string>"));
        assert!(xml.contains("return function()\nprint('hi')\nend"));
        assert!(xml.ends_with("</roblox>\n"));
    }

    #[test]
    fn cdata_round_trips_terminator() {
        let lua = "local s = \"]]>\" -- tricky\nreturn s";
        let enc = cdata(lua);
        assert_eq!(enc.matches("<![CDATA[").count(), 2);
        assert_eq!(decode_cdata(&enc), lua);
        let plain = cdata("print(1)");
        assert_eq!(plain, "<![CDATA[print(1)]]>");
    }

    #[test]
    fn hold_mode_flag() {
        let xml = render_plugin_rbxmx(1, "x", "-- hold", true);
        assert!(xml.contains("local HOLD = true"));
    }
}
