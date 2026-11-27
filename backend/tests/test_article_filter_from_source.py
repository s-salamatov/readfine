"""s7-T7: "Filter from this source" in the article's "···" menu.

The detail partial is rendered through the helper of ``test_article_redesign``.
"""
from tests.test_article_redesign import AID, _article, _detail


def _items(article):
    menu = _detail(article).find(id=f"article-menu-{AID}")
    return menu.select('a[role="menuitem"][href^="/settings/filters/new"]'), menu


def test_article_menu_filter_from_source():
    links, menu = _items(_article(feed_id=7))
    assert len(links) == 1
    link = links[0]
    assert link["href"] == "/settings/filters/new?feed=7"
    assert link.has_attr("data-rf-online-only")
    assert link.get_text(strip=True) == "Filter from this source"
    assert link.find("svg") is not None
    # It follows Copy.
    assert link.find_previous_sibling(attrs={"role": "menuitem"}).has_attr("data-copy-article")

    # A saved article with no feed has no source to filter.
    links, menu = _items(_article(feed_id=None, feed_title=None))
    assert not links
    assert "Filter from this source" not in menu.get_text()
