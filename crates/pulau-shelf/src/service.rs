//! The D-Bus interface the GNOME extension uses to place the window.

use gtk::{gio, glib};
use gtk4 as gtk;

use crate::shelf::ShelfWindow;

const INTERFACE: &str = r#"
<node>
  <interface name="io.github.pulau.ShelfWindow1">
    <method name="Show">
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
    </method>
    <method name="Hide"/>
  </interface>
</node>"#;

const OBJECT_PATH: &str = "/io/github/pulau/ShelfWindow";

/// Exports the interface on `connection`.
pub fn register(connection: &gio::DBusConnection, window: ShelfWindow) -> Result<(), glib::Error> {
    let info = gio::DBusNodeInfo::for_xml(INTERFACE)?
        .lookup_interface("io.github.pulau.ShelfWindow1")
        .expect("the interface is defined above");

    connection
        .register_object(OBJECT_PATH, &info)
        .method_call(move |_, _, _, _, method, params, invocation| match method {
            "Show" => match params.get::<(i32, i32, i32, i32)>() {
                Some((x, y, width, height)) if width > 0 && height > 0 => {
                    window.show_at(x, y, width, height);
                    invocation.return_value(None);
                }
                _ => invocation.return_error(gio::DBusError::InvalidArgs, "expected a positive size"),
            },
            "Hide" => {
                window.hide();
                invocation.return_value(None);
            }
            _ => invocation.return_error(gio::DBusError::UnknownMethod, method),
        })
        .build()?;
    Ok(())
}
