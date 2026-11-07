# Original Windows baseline failures

This is a classification of the untouched `8c5b71d2f1074bb5d1d831fa395617bf4ae2abc8` Python suite, executed with CPython 3.12 UTF-8 mode on Windows. Result: 473 tests, four failures, 44 errors, seven skips. Raw local diagnostics are excluded from the public repository. No result in this table is counted as native equivalence.

| Kind | Original test | Classification |
| --- | --- | --- |
| ERROR | `test_exec_wrapper_runs_with_the_cleaned_environment (test_agent_env.AgentEnvTests.test_exec_wrapper_runs_with_the_cleaned_environment)` | Original Python exec wrapper subprocess exits abnormally on Windows; runtime defect/portability boundary, not a native equivalence pass. |
| ERROR | `test_persisted_cli_e2e_two_receivers (test_collaborate.SubprocessProtocolTests.test_persisted_cli_e2e_two_receivers)` | Original subprocess fixture expects POSIX-style executable fake tools; native Windows CLI comparison is still required. |
| ERROR | `test_archives_symlinks_and_future_versions_are_excluded (test_doc_pins.PinTests.test_archives_symlinks_and_future_versions_are_excluded)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_file_pin_rejects_archive_symlink_and_escape (test_doc_pins.PinTests.test_file_pin_rejects_archive_symlink_and_escape)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_filter_extensions_and_latest_order_without_following_links (test_docs.DocumentTests.test_filter_extensions_and_latest_order_without_following_links)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_only_missing_sources_remove_owned_links_and_excluded_sources_stay (test_docs.DocumentTests.test_only_missing_sources_remove_owned_links_and_excluded_sources_stay)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_real_files_and_unowned_symlinks_are_never_replaced_or_deleted (test_docs.DocumentTests.test_real_files_and_unowned_symlinks_are_never_replaced_or_deleted)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_spaces_with_only_doc_tab_rules_are_indexed_by_id_without_links (test_docs.RuleOnlySpaceTests.test_spaces_with_only_doc_tab_rules_are_indexed_by_id_without_links)` | Windows symlink privilege unavailable in the fixture. |
| ERROR | `test_static_page_is_not_interactive_but_controls_are (test_render_html.RenderHtmlTests.test_static_page_is_not_interactive_but_controls_are)` | Original renderer fixture launches a POSIX-style fake executable on Windows; real WebKit validation remains macOS-specific. |
| ERROR | `test_tiles_are_cached_until_the_file_changes (test_render_html.RenderHtmlTests.test_tiles_are_cached_until_the_file_changes)` | Original renderer fixture launches a POSIX-style fake executable on Windows; real WebKit validation remains macOS-specific. |
| ERROR | `test_width_snaps_to_40px_steps_and_each_step_is_cached (test_render_html.RenderHtmlTests.test_width_snaps_to_40px_steps_and_each_step_is_cached)` | Original renderer fixture launches a POSIX-style fake executable on Windows; real WebKit validation remains macOS-specific. |
| ERROR | `test_tui_bridge (unittest.loader._FailedTest.test_tui_bridge)` | POSIX PTY/termios test cannot run on Windows. |
| FAIL | `test_launch_argv_unsets_every_marker_then_runs_the_program (test_agent_env.AgentEnvTests.test_launch_argv_unsets_every_marker_then_runs_the_program)` | Test asserts POSIX env argv although the original Windows launch_argv intentionally returns the bare program. |
| FAIL | `test_archive_classification_and_original_folder_structure (test_docs.DocumentTests.test_archive_classification_and_original_folder_structure)` | Test expects POSIX separators, but original Windows relative paths contain backslashes. |
| FAIL | `test_tiers_argument_picks_the_one_sessions_model_and_is_recorded (test_model_tier.NewWorkspace.test_tiers_argument_picks_the_one_sessions_model_and_is_recorded)` | Test asserts POSIX env argv although the original Windows launch_argv intentionally returns the bare program. |
| FAIL | `test_default_opens_exactly_one_claude_session_and_no_splits (test_workspace.WorkspaceCreationTests.test_default_opens_exactly_one_claude_session_and_no_splits)` | Test asserts POSIX env argv although the original Windows launch_argv intentionally returns the bare program. |

The earlier default-encoding run additionally failed on locale-dependent UTF-8 reads/writes. The UTF-8 run removes that confound while retaining the original assertions. Native contracts use the original observed function outputs; platform-specific integration still needs the relevant OS.

Dedicated external lifecycle test results moved with their source and are outside this release.
