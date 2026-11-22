"""Offline sync: which articles a device keeps, and the manifest it diffs against."""

# Version of the server-rendered snapshot partials the device caches. Bump it whenever
# a template the offline snapshot renders changes, so devices refetch their shell.
OFFLINE_TEMPLATE_VERSION = "4"
# sha256 (first 16 hex) of the snapshot template closure and its context helpers, as
# computed by tests/test_offline_template_version.py. Change the hash only together with
# a bump of OFFLINE_TEMPLATE_VERSION; regenerate goldens with RF_UPDATE_GOLDENS=1.
OFFLINE_TEMPLATE_HASH = "15e07a0d0fad98b0"
