"""Offline sync: which articles a device keeps, and the manifest it diffs against."""

# Version of the server-rendered snapshot partials the device caches. Bump it whenever
# a template the offline snapshot renders changes, so devices refetch their shell.
OFFLINE_TEMPLATE_VERSION = "1"
