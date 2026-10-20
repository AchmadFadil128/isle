# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting.

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately instead, through **Security → Report a vulnerability**
on this repository, or by contacting the maintainer,
[@zickrian](https://github.com/zickrian), through the contact details on that
GitHub profile.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within 7 days. Once a fix is released, you are
credited in the changelog unless you would rather not be.

## Scope

Isle runs entirely as your user. Areas where a report is especially welcome:

- `isled`'s D-Bus API on the session bus (`docs/dbus-api.md`): input that
  crashes it, or reads or changes data it should not.
- The clipboard history in `~/.local/share/isle`: copies kept from apps that
  are on the ignore list, such as password managers, or files readable by
  other users.
- Network requests: anything sent to LRCLIB or cover-art hosts beyond the
  song's title, artist, album and length.
- `isle-shelf`: files it opens or exposes that the user did not drop on it.
