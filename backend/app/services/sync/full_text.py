"""Reader-specific full-text availability shared by offline records and snapshots."""


def full_text_flag(
    *,
    readable_status: str,
    has_readable_content: bool,
    url: str | None,
    trimmed: bool,
    subscribed: bool,
    extract_readable: bool | None,
    readable_auto_disabled: bool | None,
) -> bool | None:
    """Return True for stored full text, False when expected, or None when excluded."""
    if readable_status == "success" and has_readable_content:
        return True
    if not url or trimmed or not subscribed or not extract_readable or readable_auto_disabled:
        return None
    if readable_status == "failed":
        return None
    return False
