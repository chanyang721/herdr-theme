# Retained original test correspondence

The [JSON companion](native-original-tests.json) maps retained theme behavior to
native cases or frozen corpus assertions. It records source correspondence,
not successful execution. Platform skips remain skips.

Automatic session lifecycle policies and their dedicated installer, service,
resume and policy tests moved to the external provider together with their
source. Their original snapshots are retained there for comparison. They are
excluded from this release's test inventory, rather than counted as passes.

Local document views now use producer-supplied sections and labels. Their
replacement contract cases are in `rust/tests/documents_original_install.rs`.
Runtime command output and private source schemas are not interpreted by the
theme; see [local integrations](local-integrations.md).
