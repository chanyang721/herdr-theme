## Original test function correspondence

Original Python `e383c3ce2935334c14b1f1f6e7e67426282b4e9b`: **580 declared functions + 6 dynamic aliases**. Source correspondence only; no PASS or platform acceptance claim. Skips remain skips. Test results identify the tested commit separately.

`F:=` means the same function name in file F; `F:~` drops only the original `test_` prefix. `E` references shared evidence. The JSON companion retains full namespaces, all references and corpus selectors; the table shows primary evidence. `P` retains a platform condition; `N` marks native transport substitution. Bold table rows name the original class.

Corrected untouched-original observer capture provenance: `rust/tests/fixtures/observer-inspect.provenance.json`. Latest observer method mapping: `rust/tests/fixtures/observer-original-test-map.json`. Capture provenance and source correspondence are separate from execution results.

**Evidence files**

- `F01` `rust/src/automation/bridge.rs`
- `F02` `rust/src/automation/contracts.rs`
- `F03` `rust/src/automation/mod.rs`
- `F04` `rust/src/automation/workspace_focus.rs`
- `F05` `rust/src/observers/contracts.rs`
- `F06` `rust/src/observers/jobs/database_contracts.rs`
- `F07` `rust/src/voice/gate.rs`
- `F08` `rust/src/voice/install.rs`
- `F09` `rust/src/voice/policy.rs`
- `F10` `rust/src/voice/probe.rs`
- `F11` `rust/src/voice/recovery.rs`
- `F12` `rust/src/voice/settings.rs`
- `F13` `rust/tests/automation_cli.rs`
- `F14` `rust/tests/document_tab_native_process.rs`
- `F15` `rust/tests/documents_differential.rs`
- `F16` `rust/tests/documents_original_install.rs`
- `F17` `rust/tests/documents_original_pipeline.rs`
- `F18` `rust/tests/documents_original_remaining.rs`
- `F19` `rust/tests/documents_original_render.rs`
- `F20` `rust/tests/documents_sandbox.rs`
- `F21` `rust/tests/documents_workspace_cli.rs`
- `F22` `rust/tests/fixtures/documents-python-baseline.json`
- `F23` `rust/tests/fixtures/documents-workspace-cli.json`
- `F24` `rust/tests/fixtures/workspace-focus-upstream.json`
- `F25` `rust/tests/help_cli.rs`
- `F26` `rust/tests/observer_install_migration.rs`
- `F27` `rust/tests/observer_original_cycles.rs`
- `F28` `rust/tests/observer_original_install.rs`
- `F29` `rust/tests/process_contracts.rs`
- `F30` `rust/tests/renderers_macos.rs`
- `F31` `rust/tests/rpc_cli.rs`
- `F32` `rust/tests/stub_pty.rs`
- `F33` `rust/tests/support/observer_latest_e383.rs`
- `F34` `rust/tests/update_original.rs`
- `F35` `rust/tests/voice_original_additional.rs`
- `F36` `rust/tests/voice_original_dictation.rs`
- `F37` `rust/tests/voice_original_lifecycle.rs`
- `F38` `rust/tests/windows_helpers_original.rs`
- `F39` `rust/tests/workflow_original.rs`
- `F40` `rust/tests/workspace_focus_cli.rs`
- `F41` `rust/tests/workspace_original.rs`
- `F42` `tests/prepush-native.test.mjs`
- `F43` `voice/tests/native-install.test.mjs`

**Shared evidence**

- `E01` `F02::frozen_original_general_contracts`
- `E02` `F04::tests::all_ten_original_window_scenarios_keep_their_recorded_selection`
- `E03` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [186,187,188,189,190,191] ops=empty_prompt`
- `E04` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [213] ops=process_evidence`
- `E05` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [218] ops=process_evidence`
- `E06` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [219,220,221] ops=resume_argv`
- `E07` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [281,282] ops=stub_command`
- `E08` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [283,284] ops=resume_argv`
- `E09` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [285] ops=resume_argv`
- `E10` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [286,287] ops=stub_launch,stub_command`
- `E11` `F05::frozen_python_lifecycle_contracts; rust/tests/fixtures/observer-contracts.json zero-based cases [288,289,290,291,292,293] ops=resume_argv,stub_launch,stub_command,stub_shown`
- `E12` `F07::pooling_uses_fixed_score_and_rebuilds_only_confirmed_speech`
- `E13` `F07::unenrolled_speech_never_creates_a_voiceprint`
- `E14` `F08::codex_agent_install_is_sandboxed_and_native`
- `E15` `F09::speech_must_explain_current_text`
- `E16` `F10::original_python_contract_corpus`
- `E17` `F11::independent_closure_must_match_process_and_time`
- `E18` `F11::sqlite_reader_is_bounded_metadata_only_and_preserves_failure_class`
- `E19` `F12::microphone_keys_keep_unicode`
- `E20` `F12::overrides_are_typed_and_unknown_ignored`
- `E21` `F13::persisted_two_receiver_protocol_reports_exactly_once`
- `E22` `F13::route_busy_requests_remain_retryable_then_use_same_slot`
- `E23` `F13::route_holds_are_durable_before_ambiguous_send_and_never_retry`
- `E24` `F13::route_removes_sent_request_before_failed_snapshot_refresh`
- `E25` `F13::uncertain_delivery_keeps_exclusive_leases_and_never_resends`
- `E26` `F13::wrong_actor_or_token_cannot_accept_and_cli_errors_are_json`
- `E27` `F15::original_document_contracts`
- `E28` `F20::native_base_install_preserves_custom_settings_and_updates_whole_mod`
- `E29` `F21::native_seed_matches_original_action_order_and_error_finally_restore`
- `E30` `F25::original_help_options_descriptions_and_subcommands_are_preserved`
- `E31` `F26::exact_original_review_policy_snapshots`
- `E32` `F27::cleanup_an_unreadable_app_at_the_start_skips_the_cycle`
- `E33` `F28::test_external_adapter_location_comes_from_its_local_config`
- `E34` `F28::test_imported_helpers_are_bundled_outside_the_reviewed_hash`
- `E35` `F29::hc_agent_exec_drops_parent_agent_and_pane_identity_and_propagates_exit`
- `E36` `F29::native_agent_exec_keeps_its_pane_identity_but_clears_agent_identity`
- `E37` `F31::six_cell_grid_preserves_ids_order_payload_and_unrelated_tabs`
- `E38` `F32::assert_handover via bare_cr_resumes_same_folder_clears_labels_and_identity, wrapped_hc_paste_is_handed_to_agent_as_one_prompt and long_korean_message_survives_canonical_line_limit; supplemental rust/tests/process_contracts.rs::hc_agent_exec_drops_parent_agent_and_pane_identity_and_propagates_exit`
- `E39` `F32::bare_cr_resumes_same_folder_clears_labels_and_identity`
- `E40` `F32::wrapped_hc_paste_is_handed_to_agent_as_one_prompt and long_korean_message_survives_canonical_line_limit`
- `E41` `F42::PREPUSH`
- `E42` `F42::native`

**`tests/test_agent_env.py`**

| Original class / method | Native evidence |
| --- | --- |
| **AgentEnvTests** | |
| `test_hc_terminal_drops_agent_and_parent_pane_markers` | `E35` |
| `test_native_pane_keeps_its_own_pane_identity` | `E36` |
| `test_launch_argv_unsets_every_marker_then_runs_the_program` | `F03:=` |
| `test_windows_keeps_the_plain_argv` | `F03:=` |
| `test_launch_argv_really_clears_the_markers` | `F29:=`P |
| `test_exec_wrapper_runs_with_the_cleaned_environment` | `E35`N |

**`tests/test_base_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **InstallTests** | |
| `test_fresh_install_refuses_overwrite_before_mutating` | `E28` |
| `test_update_is_idempotent_and_preserves_personal_configuration` | `E28` |
| `test_update_refreshes_unmodified_managed_layout` | `F20:=` |
| `test_update_legacy_install_preserves_existing_layout_without_manifest` | `F20:=` |

**`tests/test_close_finished_spaces.py`**

| Original class / method | Native evidence |
| --- | --- |
| **CleanupPolicyTests** | |
| `test_by_default_no_space_is_ever_closed` | `F27:~` |
| `test_the_live_close_refuses_without_the_switch` | `F27:~` |
| `test_idle_boundary_is_600_seconds_and_record_precedes_close` | `F27:~` |
| `test_dry_run_never_records_closes_or_notifies` | `F27:~` |
| `test_requires_both_30_minutes_and_seven_samples` | `F27:~` |
| `test_seven_real_dry_run_samples_reach_trial_readiness_only_at_30_minutes` | `F27:~` |
| `test_review_gate_is_required` | `F27:~` |
| `test_review_of_different_observer_is_rejected` | `F27:~` |
| `test_review_before_30_minute_trial_is_rejected` | `F27:~` |
| `test_trial_with_previous_error_never_applies` | `F27:~` |
| `test_current_space_is_never_inspected_or_closed` | `F27:~` |
| `test_active_flag_alone_prevents_cleanup` | `F27:~` |
| `test_fixed_names_ignore_case_and_fixed_ids_are_machine_specific` | `F27:~` |
| `test_remote_workspaces_are_never_assumed_safe` | `F27:~` |
| `test_working_or_unreported_agent_blocks_cleanup` | `F27:~` |
| `test_pending_input_or_wrapped_multiline_input_blocks_cleanup` | `F27:~` |
| `test_approval_wait_blocks_and_is_notified_once_per_day_after_review` | `F27:~` |
| `test_running_child_shell_or_unknown_process_blocks_cleanup` | `F27:~` |
| `test_live_subagent_terminal_blocks_cleanup` | `F27:~` |
| `test_an_empty_agent_pane_is_not_a_session_and_does_not_hold_the_space` | `F33:=` |
| `test_an_empty_pane_with_typed_input_still_blocks` | `F33:=` |
| `test_missing_process_or_terminal_evidence_blocks_cleanup` | `F27:~` |
| `test_output_change_resets_observation_window` | `F27:~` |
| `test_old_or_future_sample_resets_trial_and_idle_window` | `F27:~` |
| `test_focus_race_onto_the_space_immediately_before_close_blocks_operation` | `F27:~` |
| `test_evidence_race_immediately_before_close_blocks_operation` | `F27:~` |
| `test_failed_close_confirmation_keeps_record_and_raises` | `F27:~` |
| `test_focus_change_after_close_stops_further_cleanup` | `F27:~` |
| `test_the_person_moving_elsewhere_does_not_stop_cleanup` | `F27:~` |
| `test_the_space_the_person_is_viewing_is_kept` | `F27:~` |
| `test_close_exception_is_not_reported_as_success` | `F27:~` |
| `test_existing_record_is_appended_without_destroying_previous_content` | `F27:~` |
| `test_uncommitted_work_is_recorded_before_close_but_worktree_is_not_deleted` | `F27:~` |
| **PromptEvidenceTests** | |
| `test_only_recognized_empty_agent_prompts_count` | `E03` |
| **HarnessRecordTests** | |
| `test_harness_record_precedes_document_and_close_and_closed_follows` | `F27:~` |
| `test_refused_harness_record_keeps_the_space_and_writes_no_document` | `F27:~` |
| `test_unknown_session_id_is_a_reason_to_keep` | `F27:~` |
| `test_user_approval_replaces_the_30_minute_review_after_one_recorded_dry_run` | `F27:~` |
| `test_user_approval_is_tied_to_the_reviewed_code` | `F27:~` |
| `test_claude_input_box_borders_do_not_hide_an_empty_prompt` | `F27:~` |
| **ArchiveBeforeCloseTests** | |
| `test_archive_names_tabs_sessions_and_git_before_close` | `F27:~` |
| `test_failed_archive_keeps_the_space` | `F27:~` |
| `test_fixed_spaces_are_never_archived_or_closed_even_when_the_person_asks_now` | `F27:~` |
| `test_slept_pane_counts_as_idle_and_is_archived_with_its_session` | `F27:~` |
| `test_a_sleep_label_without_the_stub_is_not_trusted` | `F27:~` |
| `test_now_skips_the_quiet_window_and_the_switch_but_not_the_safety_checks` | `F27:~` |
| `test_default_idle_window_is_six_hours` | `F27:~` |
| **FinishedClaudeSpaceTests** | |
| `test_a_faint_suggestion_is_empty_input_but_typed_text_is_not` | `F27:~` |
| `test_answering_the_report_request_keeps_the_idle_window` | `F27:~` |
| `test_a_description_mentioning_check_needed_is_not_a_decision` | `F27:~` |
| `test_a_session_without_a_transcript_is_reported_parked_archived_and_closed` | `F27:~` |
| `test_a_child_session_with_a_running_process_is_kept` | `F27:~` |
| `test_the_workspace_record_masks_denylisted_names` | `F27:~` |
| **DecisionScreenTests** | |
| `test_auto_mode_lines_are_not_a_user_decision` | `F27:~` |
| `test_a_running_monitor_or_shell_is_in_progress` | `F27:~` |
| `test_real_questions_still_count` | `F27:~` |
| **DecisionCycleTests** | |
| `test_monitor_running_keeps_the_space_in_progress_without_a_notice` | `F27:~` |
| **HelperProcessTests** | |
| `test_claude_keep_awake_timer_is_a_helper_but_other_caffeinate_is_not` | `F27:~` |
| **HarnessCloseGateTests** | |
| `test_not_accepted_keeps_the_space_and_writes_nothing` | `F27:~` |
| `test_accepted_closes_after_the_gate` | `F27:~` |
| `test_open_task_or_escalation_keeps_it` | `F27:~` |
| `test_an_adapter_without_the_gate_never_closes` | `F27:~` |
| **HarnessCloseGateCallTests** | |
| `test_the_gate_command_and_fail_closed_answers` | `F27:~` |
| **LookupFailureTests** | |
| `test_an_unreadable_app_at_the_start_skips_the_cycle` | `E32` |
| `test_a_failing_space_lookup_keeps_that_space_only` | `F27:~` |
| `test_a_failing_recheck_keeps_the_space_without_an_error` | `F27:~` |
| **TrialRecoveryTests** | |
| `test_an_error_stops_apply_until_three_healthy_cycles_in_a_row` | `F27:~` |
| `test_the_streak_survives_the_next_cycle` | `F27:~` |
| **LiveSnapshotLookupTests** | |
| `test_one_terminal_timing_out_is_marked_and_the_others_are_read` | `F27:~` |
| **RecheckTimeoutTests** | |
| `test_a_recheck_inspect_timing_out_keeps_only_that_space` | `F27:~` |
| **SpaceLookupHoldTests** | |
| `test_a_failed_lookup_keeps_the_space_idle_window` | `F33:=` |
| `test_a_pane_lookup_error_in_the_space_is_held` | `F33:=` |

**`tests/test_collaborate.py`**

| Original class / method | Native evidence |
| --- | --- |
| **CollaborateTests** | |
| `test_thresholds_each_independently_and_unknown_is_not_inferred` | `F13:=` |
| `test_share_excluded_new_projects_included` | `F13:=` |
| `test_same_task_id_idempotent_and_no_source_steal` | `F13:=` |
| `test_write_requires_ownership_and_message_protects_shared_checkout` | `F13:=` |
| `test_two_helpers_protocol_to_single_origin_report_no_duplicates` | `E21` |
| `test_only_leased_receiver_can_accept_complete` | `E26` |
| `test_leased_task_cannot_start_locally` | `F13:=` |
| `test_local_start_reduces_pending_and_completes_as_source` | `F13:=` |
| `test_ambiguous_send_never_retries_or_expires` | `E25` |
| `test_draft_voice_question_or_busy_is_never_sent` | `E01` |
| `test_done_without_atomic_guard_is_held` | `F13:=` |
| `test_done_list_with_raw_idle_is_delivered_guarded` | `F13:=` |
| `test_overlapping_ownership_waits_while_distinct_files_can_run` | `F13:=` |
| `test_no_helper_keeps_queue_without_new_session` | `F13:=` |
| `test_corrupt_ledger_and_orphan_lease_fail_closed` | `F13:=` |
| `test_custom_exclusions_cannot_allow_share` | `F13:=` |
| `test_closed_batch_rejects_new_tasks_but_existing_id_remains_idempotent` | `F13:=` |
| `test_existing_id_cannot_move_to_another_batch` | `F13:=` |
| `test_cli_identity_mismatch_rejected` | `F13:=` |
| **SubprocessProtocolTests** | |
| `test_persisted_cli_e2e_two_receivers` | `E21` |

**`tests/test_computers.py`**

| Original class / method | Native evidence |
| --- | --- |
| **ComputersTest** | |
| `test_desktop_and_mobile_names_preserve_network_status` | `F03:=` |
| `test_only_local_status_is_executed_and_failure_is_explicit` | `F03:=` |

**`tests/test_doc_catalog.py`**

| Original class / method | Native evidence |
| --- | --- |
| **CatalogTests** | |
| `test_versions_fold_under_the_newest_and_archive_is_separate` | `E27`P |
| `test_undated_same_names_in_two_folders_stay_separate` | `E27`P |
| `test_dated_copies_in_shared_folders_join_the_same_family` | `E27`P |
| `test_pinned_document_heads_its_family_and_is_listed_once` | `E27`P |
| `test_kinds_come_from_folder_then_name_and_local_rules_replace_defaults` | `F18:=` |
| `test_labels_drop_dates_shared_prefix_and_long_hashes` | `E27`P |
| `test_reading_the_catalog_changes_no_file` | `F18:=` |
| `test_harness_sections_follow_the_folder_contract` | `F16:=`P |
| `test_harness_version_folders_fold_under_the_newest_link` | `F16:=`P |
| `test_harness_is_hidden_without_a_local_entry` | `F16:=` |
| `test_remote_machine_entry_is_not_this_mac` | `F16:=` |

**`tests/test_doc_pins.py`**

| Original class / method | Native evidence |
| --- | --- |
| **PinTests** | |
| `test_latest_date_beats_mtime_and_preserves_topic_id` | `F17:=` |
| `test_iso_dates_share_topic_with_compact_dates` | `F17:=` |
| `test_nonrecursive_pin_ignores_shared_copy_collisions_and_follows_new_date` | `F17:=` |
| `test_archives_symlinks_and_future_versions_are_excluded` | `F17:=`P |
| `test_same_date_collision_is_visible_and_missing_pin_is_retained` | `F17:=` |
| `test_recent_fourteen_day_window_topic_grouping_limit_and_no_pin_duplicate` | `F17:=` |
| `test_unicode_topic_and_recent_keyword_normalization` | `F17:=` |
| `test_missing_source_warning_is_not_an_empty_success` | `F17:=` |
| `test_file_pin_rejects_archive_symlink_and_escape` | `F17:=`P |
| `test_pin_unpin_only_changes_rules_and_excludes_auto_topic` | `F17:=` |
| `test_read_only_cli_never_writes_index_links_or_rules` | `F17:=` |
| `test_source_permission_failure_retains_pin` | `F17:=` |

**`tests/test_doc_routing.py`**

| Original class / method | Native evidence |
| --- | --- |
| **RoutingTests** | |
| `test_name_title_and_body_words_pick_the_space` | `F17:=` |
| `test_a_path_word_outweighs_a_body_mention_and_ties_go_to_the_fallback` | `F17:=` |
| `test_downloads_list_only_matching_documents_at_the_top_level` | `F17:=` |
| `test_routed_files_are_not_moved_and_are_watched` | `F17:=` |
| `test_newest_write_comes_first_whatever_the_name_date` | `F17:=` |
| `test_pins_and_folders_stay_and_a_file_is_listed_once` | `F17:=` |
| `test_title_decides_the_kind_when_the_name_says_nothing` | `F17:=` |
| `test_unknown_space_or_missing_file_routes_nothing` | `F17:=` |
| `test_cli_reads_the_routing_file_beside_the_rules` | `F17:=` |

**`tests/test_doc_tabs_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **DocumentTabInstallTests** | |
| `test_appends_one_mod_tab_without_changing_existing_tree_or_focus` | `E27`N |
| `test_recreates_same_id_after_close_and_does_not_touch_remote_spaces` | `E27`N |
| `test_existing_document_mod_inside_split_is_not_duplicated` | `E27`N |
| `test_seed_preserves_user_settings_and_original_project_config` | `F16:=` |
| `test_share_seed_uses_stable_identity_and_preserves_document_sources` | `F16:=` |
| `test_project_documents_come_from_the_machine_local_site_config` | `F16:=` |
| `test_dates_follow_latest_in_exact_directory_and_keep_disk_unicode` | `F16:=` |
| `test_native_check_failure_prevents_feature_copy` | `F16:=` |
| `test_cas_retry_rereads_concurrent_document_and_reports_focus` | `F16:=` |

**`tests/test_docs.py`**

| Original class / method | Native evidence |
| --- | --- |
| **DocumentTests** | |
| `test_filter_extensions_and_latest_order_without_following_links` | `F17:=`P |
| `test_real_files_and_unowned_symlinks_are_never_replaced_or_deleted` | `F17:=`P |
| `test_only_missing_sources_remove_owned_links_and_excluded_sources_stay` | `F17:=`P |
| `test_stable_index_and_manifest_conflict_preserve_user_files` | `F17:=` |
| `test_inaccessible_or_missing_source_is_not_silently_reported_as_empty` | `F17:=` |
| `test_korean_filename_and_match_accept_both_nfc_and_nfd_without_renaming` | `F17:=` |
| `test_archive_classification_and_original_folder_structure` | `F17:=` |
| `test_archive_source_root_is_classified_and_index_keeps_it_without_new_links` | `F17:=` |
| **RuleOnlySpaceTests** | |
| `test_spaces_with_only_doc_tab_rules_are_indexed_by_id_without_links` | `F17:=` |

**`tests/test_grid.py`**

| Original class / method | Native evidence |
| --- | --- |
| **GridTests** | |
| `test_existing_live_ids_and_unrelated_tabs_survive` | `E37` |

**`tests/test_model_tier.py`**

| Original class / method | Native evidence |
| --- | --- |
| **TierRules** | |
| `test_no_tier_is_high_and_bad_tiers_are_refused` | `F41:=` |
| `test_mapping_is_local_and_missing_tiers_move_up` | `F41:=` |
| `test_defaults_name_real_models_efforts_and_max_is_only_chosen` | `F41:=` |
| `test_flags_per_cli` | `F41:=` |
| `test_session_tier_from_model_and_effort_unknown_is_high_lower_never_chosen` | `F41:=` |
| `test_session_models_read_the_pane_header_share` | `F41:=` |
| **NewWorkspace** | |
| `test_without_the_option_the_one_session_is_the_cli_default` | `F41:=` |
| `test_tiers_argument_picks_the_one_sessions_model_and_is_recorded` | `F41:=`P |
| `test_old_six_value_site_setting_uses_only_its_first_value` | `F41:=` |
| `test_more_than_one_tier_or_an_unknown_tier_is_refused_before_any_pane_opens` | `F41:=` |
| **Receivers** | |
| `test_collaborate_orders_same_model_then_higher_and_skips_lower` | `F41:=` |
| `test_route_keeps_its_old_order_without_a_tier_and_never_goes_lower` | `F41:=` |

**`tests/test_open_doc_tab.py`**

| Original class / method | Native evidence |
| --- | --- |
| **ChooseSpaceTests** | |
| `test_rules_of_removed_spaces_are_skipped` | `E27`P |
| `test_keyword_rule_beats_bare_folder` | `E27`P |

**`tests/test_prepush_setup.py`**

| Original class / method | Native evidence |
| --- | --- |
| **PrePushSetupTests** | |
| `test_path_conversion_failure_stops_before_checks` | `E42`N |
| `test_zero_tests_run_fails_the_push` | `E42`N |
| `test_pythonpath_from_the_caller_is_ignored` | `E42`N |
| `test_prepush_variables_cannot_skip_checks_in_a_real_push` | `E41`N |

**`tests/test_preview_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **PreviewInstallTests** | |
| `test_replacing_content_preserves_layout_dimensions_visibility_and_other_panes` | `F20:=` |
| `test_absent_files_node_preserves_tree` | `E27` |
| `test_layout_without_a_files_panel_installs_nothing` | `F20:=` |

**`tests/test_render_html.py`**

| Original class / method | Native evidence |
| --- | --- |
| **RenderHtmlTests** | |
| `test_missing_renderer_reports_install_notice` | `F19:=` |
| `test_tiles_are_cached_until_the_file_changes` | `F19:=` |
| `test_width_snaps_to_40px_steps_and_each_step_is_cached` | `F19:=` |
| `test_static_page_is_not_interactive_but_controls_are` | `F19:=` |
| **InteractiveTests** | |
| `test_static_reports_and_chart_only_pages_pass` | `E27` |
| `test_markup_shown_as_text_is_ignored` | `E27` |
| `test_each_kind_of_control_is_named` | `E27` |
| **LiveRendererTests** | |
| `test_short_page_is_as_tall_as_its_content` | `F30:=`P |
| `test_viewport_height_sections_and_late_script_content_are_measured_once` | `F30:=`P |

**`tests/test_render_mermaid.py`**

| Original class / method | Native evidence |
| --- | --- |
| **MermaidBlockTests** | |
| `test_matches_the_tab_fence_rules` | `E27` |
| `test_unclosed_and_short_closing_fences_are_not_diagrams` | `E27` |

**`tests/test_route.py`**

| Original class / method | Native evidence |
| --- | --- |
| **RouteTests** | |
| `test_share_and_stable_space_id_survive_workspace_rename` | `F13:=` |
| `test_same_position_wins_then_busy_falls_back_to_same_agent_kind` | `F13:=` |
| `test_all_busy_or_blocked_returns_no_target_instead_of_interrupting` | `F13:=` |
| `test_agent_became_busy_after_selection_is_never_sent_the_message` | `F13:=` |
| `test_drafts_recording_and_pending_questions_are_protected` | `F13:=` |
| `test_voice_and_recording_below_composer_are_protected` | `F13:=` |
| `test_only_explicit_reply_requests_add_a_completion_report` | `F13:=` |
| `test_claude_question_remains_protected_below_timing_lines` | `F13:=` |
| `test_sent_request_is_removed_before_a_failed_refresh` | `E24` |
| `test_new_uncertain_request_is_held_and_never_automatically_retried` | `E23` |
| `test_busy_request_clears_attempt_hold_for_a_later_drain` | `E22` |
| `test_unknown_project_or_non_common_source_is_not_guessed` | `F13:=` |
| `test_uncertain_send_is_not_retried_to_a_second_agent` | `F13:=` |

**`tests/test_seed_workspace_pins.py`**

| Original class / method | Native evidence |
| --- | --- |
| **SeedPinsTests** | |
| `test_first_seed_creates_only_missing_local_spaces_then_second_run_is_read_only` | `F18:=` |
| `test_existing_manual_configuration_is_preserved_without_contacting_app` | `F18:=` |
| `test_missing_space_without_ensure_does_not_write_partial_configuration` | `F18:=` |
| `test_creation_failure_restores_original_selection_and_does_not_write_config` | `E29` |

**`tests/test_session_sleep.py`**

| Original class / method | Native evidence |
| --- | --- |
| **SleepTests** | |
| `test_visible_workspace_focused_pane_and_excluded_address_never_sleep` | `F27:~` |
| `test_other_tabs_of_the_shown_space_may_sleep_but_the_shown_tab_may_not` | `F27:~` |
| `test_a_pane_shown_in_a_float_never_sleeps` | `F27:~` |
| `test_a_faint_claude_suggestion_is_not_input_but_typed_text_is` | `F27:~` |
| `test_a_suggestion_with_text_below_the_input_row_is_still_input` | `F27:~` |
| `test_focus_moving_elsewhere_during_a_cycle_does_not_block_sleep` | `F27:~` |
| `test_focus_moving_onto_the_candidate_keeps_it` | `F27:~` |
| `test_a_child_session_without_a_session_file_is_named_and_kept` | `F27:~` |
| `test_a_child_session_reports_sleeps_and_wakes_as_a_new_session` | `F27:~` |
| `test_an_agent_that_is_the_terminal_program_never_sleeps` | `F27:~` |
| `test_sleep_never_closes_panes_tabs_or_spaces` | `F27:~` |
| `test_order_is_harness_then_exit_then_stub_then_labels` | `F27:~` |
| `test_no_harness_record_no_sleep` | `F27:~` |
| `test_dry_run_types_nothing` | `F27:~` |
| `test_twenty_minutes_unchanged_is_required` | `F27:~` |
| `test_each_blocking_condition` | `F27:~` |
| `test_apply_needs_approval_of_this_exact_code` | `F27:~` |
| `test_agent_that_does_not_exit_is_recorded_back_and_stops_the_cycle` | `F27:~` |
| `test_already_asleep_pane_is_left_alone` | `F27:~` |
| **CloseReportTests** | |
| `test_first_cycle_asks_and_does_not_sleep` | `F27:~` |
| `test_after_the_report_the_session_sleeps_without_another_twenty_minutes` | `F27:~` |
| `test_no_report_within_the_limit_keeps_the_session_and_does_not_ask_again_at_once` | `F27:~` |
| `test_waiting_within_the_limit_keeps_it` | `F27:~` |
| `test_work_after_the_request_needs_a_new_report` | `F27:~` |
| `test_typed_input_still_blocks_even_with_a_report` | `F27:~` |
| `test_park_carries_the_report_task_and_masks` | `F27:~` |
| `test_close_status_parses_the_harness_answer` | `F27:~` |
| **EvidenceTests** | |
| `test_idle_codex_helpers_are_allowed` | `E05` |
| `test_a_command_under_a_helper_is_still_work` | `E04` |
| `test_resume_keeps_flags_and_replaces_an_old_resume` | `E06` |
| `test_pane_session_id_matches_the_harness_and_is_a_uuid` | `F27:~` |
| `test_cleanup_records_are_masked` | `F27:~` |
| `test_summary_carries_no_paths` | `F27:~` |
| `test_harness_failure_modes_are_not_ok` | `F27:~` |
| **StubTests** | |
| `test_message_is_handed_over_as_the_first_prompt` | `E07` |
| `test_the_agent_starts_without_inherited_child_markers` | `E38`P |
| `test_enter_as_a_bare_cr_resumes_in_the_original_folder_and_clears_labels` | `E39`P |
| `test_an_hc_send_message_is_handed_over_whole` | `E40`P |
| `test_message_text_is_cleaned_of_paste_markers_and_crs` | `F27:~` |
| **InstallTests** | |
| `test_registers_its_own_label_in_dry_run_with_the_stub` | `F28:=` |
| **ReportGateTimingTests** | |
| `test_a_report_written_before_the_request_is_not_an_answer` | `F27:~` |
| `test_a_report_after_the_limit_is_not_accepted` | `F27:~` |
| `test_a_report_written_in_time_counts_even_when_the_observer_looks_late` | `F27:~` |
| `test_a_report_accepted_in_time_stays_ready_on_later_cycles` | `F27:~` |
| **AlreadyReportedTests** | |
| `test_a_report_from_its_last_work_is_ready_without_asking` | `F27:~` |
| `test_an_old_report_before_later_work_does_not_count` | `F27:~` |
| `test_a_session_that_answered_an_earlier_request_points_to_its_older_report` | `F27:~` |
| `test_answering_a_pending_request_with_an_earlier_report_is_ready` | `F27:~` |
| `test_work_after_the_request_still_asks_again` | `F27:~` |
| `test_the_memory_window_answer_is_not_a_user_decision` | `F27:~` |
| **ProcessTableDecodeTests** | |
| `test_ps_args_cut_mid_character_do_not_fail_the_observer` | `F27:~` |
| **TicketArgvTests** | |
| `test_claude_prompts_and_one_shot_flags_are_dropped` | `E08` |
| `test_codex_prompt_dropped_flags_kept` | `E09` |
| `test_ticket_written_by_observer_has_no_prompt` | `F27:~` |
| `test_old_ticket_is_cleaned_when_woken_and_screen_is_short` | `E11` |
| `test_new_session_ticket_left_as_written` | `E10` |
| **PaneCloseTests** | |
| `test_a_finished_session_in_a_space_with_another_pane_is_closed` | `F27:~` |
| `test_the_last_pane_of_its_space_sleeps_instead` | `F27:~` |
| `test_two_finished_sessions_in_a_two_pane_space_keep_one_pane` | `F27:~` |
| `test_no_harness_record_no_close` | `F27:~` |
| `test_a_pane_still_there_after_close_stops_everything` | `F27:~` |
| `test_work_input_or_focus_that_starts_while_parking_keeps_the_pane` | `F27:~` |
| `test_a_failed_closed_record_is_not_reported_as_closed_and_is_retried` | `F27:~` |
| `test_while_a_closed_record_is_missing_nothing_else_acts` | `F27:~` |
| `test_an_unrecorded_close_survives_an_exception_later_in_the_cycle` | `F27:~` |
| `test_a_layout_unreadable_right_after_pane_close_is_not_recorded_as_aborted` | `F27:~` |
| `test_an_unconfirmed_close_whose_pane_is_still_there_is_settled_as_aborted` | `F27:~` |
| `test_an_unreadable_app_at_the_start_skips_the_cycle` | `F27:~` |
| `test_one_pane_lookup_timing_out_keeps_only_that_pane` | `F27:~` |
| `test_a_recheck_lookup_failure_before_close_settles_and_keeps` | `F27:~` |
| `test_main_skips_without_counting_an_error_and_errors_clear_after_healthy_cycles` | `F27:~` |
| `test_a_long_gap_does_not_clear_an_earlier_error` | `F27:~` |
| `test_a_failing_pane_close_is_settled_with_close_aborted_and_stops` | `F27:~` |
| `test_the_last_pane_of_a_hidden_tab_is_not_closed_even_if_the_space_keeps_others` | `F27:~` |
| `test_switched_off_it_sleeps` | `F27:~` |
| `test_close_reports_off_never_close` | `F27:~` |
| `test_live_close_pane_closes_by_id_only` | `F27:~` |
| `test_dry_run_types_nothing_and_says_what_it_would_do` | `F27:~` |
| `test_a_finished_agent_that_is_the_terminal_program_is_closed` | `F27:~` |
| `test_a_non_shell_last_pane_is_kept_after_its_report` | `F27:~` |
| `test_a_finished_session_in_the_shown_tab_is_closed_but_never_the_focused_pane` | `F27:~` |
| `test_the_shown_tab_still_blocks_sleep_and_its_last_pane_is_not_closed` | `F27:~` |
| `test_typed_input_or_a_float_blocks_closing_and_asking` | `F27:~` |
| `test_a_kept_session_is_asked_once_for_its_report` | `F27:~` |
| `test_collect_after_seconds_asks_before_idle_seconds_without_closing` | `F27:~` |
| `test_dry_run_collect_types_nothing` | `F27:~` |
| **SpareCloseTests** | |
| `test_an_empty_pane_closes_without_a_harness_record_when_its_space_keeps_another` | `F33:=` |
| `test_an_empty_pane_is_never_asked_for_a_report_and_waits_the_idle_window` | `F33:=` |
| `test_the_last_pane_of_a_space_stays_even_when_empty` | `F33:=` |
| `test_an_empty_pane_with_typed_input_is_not_empty` | `F33:=` |
| `test_dry_run_says_would_close_empty` | `F33:=` |
| `test_a_finished_asleep_pane_closes_with_its_harness_records` | `F33:=` |
| `test_an_asleep_pane_without_a_close_report_stays_asleep` | `F33:=` |
| **EmptyAgentTests** | |
| `test_claude_turn_zero_without_transcript_is_empty` | `F33:=` |
| `test_a_transcript_or_a_turn_means_input_was_received` | `F33:=` |
| `test_unreadable_or_resumed_sessions_are_not_empty` | `F33:=` |
| `test_codex_without_a_rollout_is_empty_and_config_flags_are_not_resume` | `F33:=` |
| **TrimFixedTests** | |
| `test_the_keeper_is_configured_else_working_else_the_agent_used_last` | `F33:=` |
| `test_an_asleep_pane_without_a_close_report_closes_with_its_records` | `F33:=` |
| `test_the_keeper_is_never_closed` | `F33:=` |
| `test_an_agent_without_a_report_in_time_is_closed_with_its_lifecycle` | `F33:=` |
| `test_outside_a_trimmed_workspace_no_report_still_keeps_the_pane` | `F33:=` |
| `test_protections_still_keep_a_trimmed_pane` | `F33:=` |
| `test_an_agentless_shell_pane_is_kept_because_unsent_input_cannot_be_read` | `F33:=` |
| `test_a_shell_with_typed_text_or_a_running_command_stays` | `F33:=` |
| **BridgeKeptTests** | |
| `test_a_bridge_pane_is_always_kept` | `F33:=` |
| `test_the_bridge_close_path_is_gone` | `F33:=` |
| **KeeperAwakeTests** | |
| `test_a_live_agent_pane_is_chosen_over_an_asleep_one_used_later` | `F33:=` |
| `test_the_live_keeper_is_never_slept_asked_or_closed` | `F33:=` |
| `test_an_asleep_keeper_is_woken_with_enter` | `F33:=` |
| `test_a_dry_run_only_says_it_would_wake` | `F33:=` |
| `test_protections_stop_the_wake` | `F33:=` |
| `test_a_wake_that_does_not_start_the_agent_is_reported` | `F33:=` |
| `test_a_different_session_after_waking_is_a_mismatch_not_a_wake` | `F33:=` |
| `test_a_new_session_ticket_is_not_woken` | `F33:=` |
| `test_a_working_shell_is_kept_but_is_never_the_keeper` | `F33:=` |
| `test_a_configured_shell_is_not_the_keeper` | `F33:=` |
| `test_a_space_with_only_shells_has_no_keeper_and_is_not_trimmed` | `F33:=` |
| **ShareUserControlledTests** | |
| `test_share_panes_are_never_slept_asked_or_closed` | `F33:=` |
| `test_share_asleep_or_long_unreported_panes_stay_too` | `F33:=` |
| `test_the_same_panes_in_another_workspace_are_handled` | `F33:=` |
| **ReReviewP1Tests** | |
| `test_typed_but_unsent_input_in_an_asleep_pane_keeps_it` | `F33:=` |
| `test_input_left_typed_for_the_whole_idle_window_still_keeps_it` | `F33:=` |
| `test_input_typed_while_parking_an_asleep_pane_keeps_it` | `F33:=` |
| `test_typed_text_ending_in_the_session_id_is_input` | `F33:=` |
| `test_real_stub_screens_wrapped_or_indented_are_read` | `F33:=` |
| `test_an_unreadable_stub_screen_is_not_closed` | `F33:=` |
| **LookupHoldTests** | |
| `test_a_failed_lookup_keeps_the_idle_window_and_the_pane_closes_later` | `F33:=` |
| `test_an_inspect_that_raises_is_held_too` | `F33:=` |
| `test_a_real_change_after_the_hold_still_resets_it` | `F33:=` |
| `test_a_skipped_cycle_counts_as_looked_for_the_sample_gap` | `F33:=` |

**`tests/test_space_cleanup_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **InstallTests** | |
| `test_plan_has_no_side_effects_and_defaults_to_dry_run` | `F28:=` |
| `test_registers_only_dry_run_and_is_idempotent` | `F28:=` |
| `test_imported_helpers_are_copied_beside_the_observer_outside_the_reviewed_hash` | `E34` |
| `test_existing_settings_are_preserved` | `F28:=` |
| `test_apply_refuses_missing_or_unobserved_trial` | `F28:=` |
| `test_apply_switch_requires_current_code_and_finished_review_window` | `F28:=` |
| `test_user_approved_apply_needs_one_recorded_dry_run_of_the_current_code` | `F28:=` |
| `test_harness_location_comes_from_the_harness_local_config` | `E33` |
| **RefreshTests** | |
| `test_copies_match_the_source_and_an_approval_for_the_replaced_copy_does_not_carry_over` | `F28:=` |
| `test_an_approval_for_other_code_is_not_kept_for_this_copy` | `F28:=` |
| `test_nothing_is_written_when_no_observer_is_registered` | `F28:=` |
| **ReviewPolicyTests** | |
| `test_pass_and_install_only_conditional_are_approved` | `E31` |
| `test_every_other_result_is_not_approved` | `E31` |
| `test_a_later_hold_on_the_same_commit_wins` | `E31` |
| `test_refresh_records_the_policy_approval_for_both_observers` | `F28:=` |
| `test_refresh_without_an_allowing_review_installs_but_does_not_approve` | `F28:=` |
| **CarriedApprovalTests** | |
| `test_is_judged_again_and_recorded_when_the_review_allows` | `F28:=` |
| `test_is_withdrawn_when_the_review_does_not_allow` | `F28:=` |

**`tests/test_space_job_evidence.py`**

| Original class / method | Native evidence |
| --- | --- |
| **CodexJobEvidenceTests** | |
| `test_complete_main_without_children_has_stable_fingerprint` | `F06:=` |
| `test_missing_or_reused_pid_created_session_agent_mapping_holds` | `F06:=` |
| `test_missing_db_schema_rollout_or_status_timestamp_holds` | `F06:=` |
| `test_freshness_rejects_five_second_old_main_mapping` | `F06:=` |
| `test_incomplete_oversized_wrong_identity_or_truncated_history_holds` | `F06:=` |
| `test_main_or_open_child_working_or_unknown_holds` | `F06:=` |
| `test_completed_or_aborted_child_can_be_verified_even_with_open_edge` | `F06:=` |
| `test_closed_child_background_exec_still_blocks_parent` | `F06:=` |
| `test_running_exec_session_requires_matched_poll_exit_not_task_completion` | `F06:=` |
| `test_raw_javascript_write_stdin_and_array_text_json_are_correlated` | `F06:=` |
| `test_unrelated_sync_exit_does_not_close_an_open_session` | `F06:=` |
| `test_program_stdout_cannot_forge_completion_of_an_unrelated_session` | `F06:=` |
| `test_backend_cell_must_finish_via_matching_wait` | `F06:=` |
| `test_wait_can_finish_cell_but_reveal_still_running_exec_session` | `F06:=` |
| `test_wrong_poll_or_wait_identity_and_missing_output_hold` | `F06:=` |
| `test_unknown_shell_output_and_closed_child_missing_log_hold` | `F06:=` |
| `test_completed_code_cell_mentioning_exec_command_is_a_result` | `F06:=` |
| `test_refused_spawn_without_output_after_task_end_is_not_work` | `F06:=` |
| `test_open_exec_sessions_pass_only_with_a_clean_process_tree` | `F06:=` |
| `test_closed_child_needs_no_finished_turn_but_its_commands_still_count` | `F06:=` |
| `test_child_graph_cycle_cannot_be_accepted` | `F06:=` |
| `test_no_file_database_or_process_writes_are_performed` | `F06:=` |
| **ClaudeJobEvidenceTests** | |
| `test_verified_completed_log_can_be_accepted` | `F06:=` |
| `test_metadata_lines_rewritten_without_work_keep_the_fingerprint` | `F06:=` |
| `test_missing_process_meta_or_unknown_completion_is_unverified` | `F06:=` |
| `test_background_bash_blocks_even_after_end_turn` | `F06:=` |
| `test_unfinished_or_unidentified_subagent_blocks` | `F06:=` |
| `test_api_request_copies_of_tool_results_are_not_events` | `F06:=` |
| `test_compaction_is_read_through` | `F06:=` |
| `test_idle_compaction_after_end_turn_is_not_a_new_prompt` | `F06:=` |
| `test_background_job_blocks_until_its_completion_notice` | `F06:=` |
| `test_stopped_background_job_and_denied_launch_do_not_block` | `F06:=` |
| `test_async_agent_blocks_until_notified` | `F06:=` |
| `test_unicode_line_separators_inside_strings_do_not_split_records` | `F06:=` |
| `test_finished_subagent_ending_on_its_result_tool_is_accepted` | `F06:=` |
| **TruncatedHostMetadataTests** | |
| `test_complete_exit_metadata_before_truncated_stdout_is_evidence` | `F06:=` |
| `test_unframed_or_incomplete_result_remains_unknown` | `F06:=` |
| `test_stdout_cannot_forge_truncated_host_exit` | `F06:=` |

**`tests/test_tui_bridge.py`**

| Original class / method | Native evidence |
| --- | --- |
| **BoundaryTests** | |
| `test_split_mouse_mode_is_not_a_safe_injection_point` | `F01:=` |
| `test_split_osc_and_string_terminators` | `F01:=` |
| `test_charset_designation_and_split_utf8` | `F01:=` |

**`tests/test_update_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **UpdateInstallTests** | |
| `test_checks_complete_candidate_then_atomically_exchanges_and_preserves_unlisted_files` | `F34:=` |
| `test_import_cache_created_during_reload_is_not_a_concurrent_code_edit` | `F34:=` |
| `test_missing_selected_dependency_fails_before_installation` | `F34:=` |
| `test_post_install_errors_restore_complete_mod_and_remove_new_files` | `F34:=` |
| `test_preexisting_errors_refuse_install_by_default` | `F34:=` |
| `test_authorized_repair_allows_initial_errors_but_requires_final_zero` | `F34:=` |
| `test_authorized_repair_with_persistent_errors_still_rolls_back` | `F34:=` |
| `test_focus_change_is_reported_and_content_is_rolled_back_without_focus_commands` | `F34:=` |
| `test_a_person_using_the_app_does_not_roll_back_helper_scripts` | `F34:=` |
| `test_existing_installation_lock_refuses_all_cli_and_file_changes` | `F34:=` |
| `test_rollback_does_not_overwrite_an_uncooperative_later_writer` | `F34:=` |
| `test_unchanged_candidate_causes_no_native_check_or_mod_exchange` | `F34:=` |
| `test_recovery_mod_clones_and_escaping_targets_are_refused` | `F34:=` |
| `test_script_destination_matches_initial_installer` | `F34:=`N |
| `test_layout_files_roll_back_together_with_mod` | `F34:=` |
| `test_exchange_swaps_directory_contents_and_leaves_no_scratch_path` | `F34:=` |
| `test_windows_failed_second_rename_restores_the_installed_directory` | `F34:=`P |
| **VoiceRoutingTests** | |
| `test_voice_alone_skips_the_app_update` | `F34:=` |
| `test_app_files_and_voice_install_both_in_order` | `F34:=` |
| `test_a_failed_voice_install_fails_the_update` | `F34:=` |

**`tests/test_windows_helpers.py`**

| Original class / method | Native evidence |
| --- | --- |
| **PortableHelpers** | |
| `test_document_index_is_utf8_even_without_python_utf8_mode` | `F38:=` |
| `test_browser_reuses_ego_profile_and_hides_console` | `F19:=`P |
| `test_lock_contends_across_processes_and_keeps_owner_readable` | `F38:=` |
| `test_document_and_message_helpers_import_on_windows` | `E30`N |

**`tests/test_workflow_collector.py`**

| Original class / method | Native evidence |
| --- | --- |
| **WorkflowCollectorTests** | |
| `test_background_core_queries_suppress_windows_console_windows` | `F39:=`P |
| `test_gui_collector_does_not_allocate_a_console_for_its_core_query` | `F29:=`P |
| `test_same_pty_and_agent_pid_can_switch_session` | `F39:=` |
| `test_bridged_claude_session_is_rechecked_without_pid_change` | `F39:=` |
| `test_history_is_baseline_and_only_a_new_child_generates_a_delegation` | `F39:=` |
| **LifecycleTests** | |
| `test_fork_history_is_reset_and_completion_does_not_close_link` | `F39:=` |
| `test_claude_stop_hook_is_completion_without_finished_metadata` | `F39:=` |
| **WindowsTests** | |
| `test_utf8_transcript_reads_on_any_locale` | `F39:=` |
| `test_remote_terminal_pid_is_not_looked_up_here` | `F39:=` |
| `test_second_collector_does_not_take_the_lock` | `F39:=` |
| `test_codex_thread_comes_from_the_root_rollout_a_process_holds` | `F39:=` |
| `test_codex_resumed_under_a_new_pid_is_found_again` | `F39:=` |

**`tests/test_workspace.py`**

| Original class / method | Native evidence |
| --- | --- |
| **WorkspaceCreationTests** | |
| `test_default_opens_exactly_one_claude_session_and_no_splits` | `F41:=`P |
| `test_shells_open_one_plain_shell` | `F41:=` |
| `test_pane_count_and_multi_tier_options_are_gone` | `F41:=` |
| `test_single_tier_is_accepted_and_invalid_one_refused` | `F41:=` |
| `test_old_six_value_site_setting_uses_first_value_with_warning` | `F41:=` |
| `test_duplicate_name_does_not_create_more_terminals` | `F41:=` |

**`tests/test_workspace_focus.py`**

| Original class / method | Native evidence |
| --- | --- |
| **KeepFocusTests** | |
| `test_the_new_space_does_not_take_the_selection` | `E02` |
| `test_a_selection_the_creation_did_not_move_stays` | `E02` |
| `test_a_person_choosing_another_existing_space_meanwhile_is_not_overridden` | `E02` |
| `test_a_failure_before_the_terminal_shows_still_undoes_what_the_creation_moved` | `E02` |
| `test_a_failure_that_moved_nothing_leaves_a_persons_choice_alone` | `E02` |
| `test_a_person_choosing_a_mod_pane_meanwhile_is_not_overridden` | `E02` |
| `test_a_failure_leaves_a_persons_mod_pane_choice_alone` | `E02` |
| `test_the_new_space_taking_over_from_a_mod_pane_is_undone` | `E02` |
| `test_another_jobs_new_pane_chosen_meanwhile_is_not_overridden` | `E02` |
| `test_known_limit_a_failed_creation_cannot_tell_a_concurrent_pane_from_its_own` | `E02` |

**`tests/test_workspace_mods.py`**

| Original class / method | Native evidence |
| --- | --- |
| **PinTests** | |
| `test_lists_each_pinned_mods_runtime_files_and_skips_generated_ones` | `F16:=` |
| `test_a_checkout_at_another_commit_or_with_changes_is_refused` | `F16:=` |
| `test_unsafe_or_incomplete_pins_are_refused` | `F16:=` |
| `test_fetches_the_pinned_commit_into_an_empty_cache` | `F16:=` |
| `test_a_failed_fetch_leaves_no_cache_behind_and_the_next_try_works` | `F16:=` |
| `test_installs_pinned_to_different_commits_keep_separate_checkouts` | `F16:=` |
| `test_ignored_files_in_a_checkout_are_not_installed` | `F16:=` |
| `test_records_the_installed_release_and_finds_a_files_layout` | `F16:=` |
| **InstallerTests** | |
| `test_the_first_install_brings_the_pinned_mods_with_the_theme` | `F16:=` |
| `test_updater_includes_the_pinned_mods_by_default_and_not_for_voice_alone` | `F16:=` |
| `test_pinned_targets_are_checked_like_listed_files` | `F16:=` |
| `test_a_linked_mods_folder_is_refused` | `F16:=` |
| `test_the_later_document_viewer_command_names_the_home_and_quotes_paths` | `F16:=` |

**`voice/tests/test_app_backend.py`**

| Original class / method | Native evidence |
| --- | --- |
| **AppFocusTests** | |
| `test_bridged_focus_overrides_stale_tui_focus` | `E16` |
| `test_native_focus_never_leaves_a_tui_microphone_selected` | `E16` |
| `test_background_app_does_not_override_tui_focus` | `E16` |
| **NativeVoiceSafetyTests** | |
| `test_existing_codex_connection_is_never_toggled` | `F36:=` |
| `test_native_microphone_key_goes_only_to_its_target` | `F36:=` |
| **StaleHeartbeatTests** | |
| `test_stale_heartbeat_asks_the_window_instead_of_trusting_tui_focus` | `F35:=` |
| `test_stale_heartbeat_follows_a_bridged_focus_to_its_tui_pane` | `F35:=` |
| `test_unknown_window_focus_leaves_no_tui_microphone_live` | `F35:=` |
| `test_docs_tab_focus_does_not_fall_back_to_the_last_agent` | `F35:=` |
| `test_app_in_background_keeps_tui_focus` | `F35:=` |
| `test_asked_focus_never_starts_a_voice_connection` | `F36:=` |

**`voice/tests/test_app_dictation.py`**

| Original class / method | Native evidence |
| --- | --- |
| **NativeDictationTests** | |
| `test_finished_native_dictation_targets_its_core_terminal` | `F36:=` |
| `test_finishing_after_focus_left_keeps_the_original_core_target` | `F36:=` |

**`voice/tests/test_codex_focus_guard.py`**

| Original class / method | Native evidence |
| --- | --- |
| **RoutingTests** | |
| `test_other_microphone_is_muted_before_owned_focus_resumes` | `F37:=` |
| `test_initial_manual_mute_is_preserved` | `F37:=` |
| `test_unknown_focus_mutes_every_live_microphone` | `F37:=` |
| `test_failed_background_mute_prevents_unmute` | `F37:=` |
| `test_unknown_process_identity_can_mute_but_never_resume` | `F37:=` |
| `test_new_process_never_inherits_unmute_permission` | `F37:=` |
| `test_missing_connection_drops_resume_permission_without_keys` | `F37:=` |
| `test_ambiguous_footer_blocks_unmute_and_receives_no_keys` | `F37:=` |
| `test_focus_change_during_unmute_is_immediately_remuted` | `F37:=` |
| `test_focus_change_before_unmute_never_receives_key` | `F37:=` |
| **MappingTests** | |
| `test_window_focus_is_mapped_to_source_pane_without_sidebar` | `F35:=` |
| `test_unknown_front_app_is_never_permission_to_listen` | `F35:=` |
| `test_iterm_front_does_not_identify_which_window_is_focused` | `F35:=` |
| `test_bridge_is_not_a_second_microphone` | `F35:=` |
| **InstallerTests** | |
| `test_installer_writes_only_its_agent_and_state_in_isolated_home` | `E14` |

**`voice/tests/test_codex_voice_focus.py`**

| Original class / method | Native evidence |
| --- | --- |
| **CodexFocusTests** | |
| `test_legacy_event_delegates_to_the_serialized_controller` | `F37:=` |
| **SettleTests** | |
| `test_a_focus_blink_never_moves_the_microphone` | `F36:=` |

**`voice/tests/test_dictation.py`**

| Original class / method | Native evidence |
| --- | --- |
| **DiscardTests** | |
| `test_dictation_the_gate_did_not_pass_is_gone_before_claude_submits_it` | `F36:=` |
| **StoppedRecordingTests** | |
| `test_own_text_is_sent_so_the_next_recording_can_start` | `F36:=` |
| `test_other_voice_is_erased_not_sent` | `F36:=` |
| **StopKeyTests** | |
| `test_own_dictation_is_finished_not_discarded` | `F36:=` |
| `test_dictation_on_an_unlearned_microphone_is_discarded` | `F36:=` |
| `test_own_voice_on_a_laptop_microphone_is_not_sent` | `F36:=` |
| `test_other_voice_is_discarded` | `F36:=` |
| `test_speech_from_before_this_recording_does_not_finish_it` | `F36:=` |
| `test_empty_recording_only_takes_esc_when_idle` | `F36:=` |
| **VoiceKeyTests** | |
| `test_two_misses_hold_the_key_back_for_a_while` | `F36:=` |
| `test_misses_do_not_lock_a_session_out_for_good` | `F36:=` |
| `test_a_count_saved_before_the_retry_is_tried_again` | `F36:=` |
| `test_turning_voice_back_on_lifts_the_hold_at_once` | `F36:=` |
| `test_a_recording_clears_the_misses` | `F36:=` |
| **RefusedDictationTests** | |
| `test_refused_text_is_erased_when_it_comes_back` | `F36:=` |
| `test_waits_for_the_text_to_come_back` | `F36:=` |
| `test_a_late_draft_is_left_alone` | `F36:=` |
| **HandTypedTests** | |
| `test_typing_while_recording_is_neither_erased_nor_sent` | `F36:=` |
| `test_typed_text_left_after_the_recording_ends_stays` | `F36:=` |
| `test_a_dictation_corrected_by_hand_is_not_sent` | `F36:=` |
| `test_own_speech_after_a_correction_is_sent` | `F36:=` |
| `test_other_voice_after_a_correction_takes_only_its_own_words` | `F36:=` |
| `test_a_corrected_dictation_gets_the_next_recording` | `F36:=` |
| `test_a_typed_draft_does_not_start_a_recording` | `F36:=` |
| **LeavingPaneTests** | |
| `test_speech_judged_a_moment_later_is_finished_not_discarded` | `F36:=` |
| `test_unjudged_speech_is_put_back_after_esc` | `F36:=` |
| `test_other_voice_is_still_discarded` | `F36:=` |
| **RestoreBoxTests** | |
| `test_unjudged_speech_is_typed_back_and_kept` | `F36:=` |
| `test_other_voice_leaves_only_what_the_user_kept` | `F36:=` |
| `test_app_panes_cannot_be_typed_into` | `F36:=` |
| **LaptopMicrophoneTests** | |
| `test_recording_is_stopped_and_not_restarted` | `F36:=` |
| `test_nothing_dictated_is_sent` | `F36:=` |
| **DictationTests** | |
| `test_room_noise_does_not_hold_back_a_finished_sentence` | `F36:=` |
| `test_unfinished_sentence_is_not_sent` | `F36:=` |
| `test_finished_sentence_is_sent_after_focus_left` | `F36:=` |
| `test_unfinished_sentence_stays_after_focus_left` | `F36:=` |

**`voice/tests/test_install.py`**

| Original class / method | Native evidence |
| --- | --- |
| **InstallTests** | |
| `test_everything_moves_to_the_installed_copy` | `F43:=`P |
| `test_a_second_run_changes_nothing` | `F43:=`P |
| `test_moving_an_install_without_the_hook_does_not_add_it` | `F43:=`P |
| `test_a_new_install_adds_the_hook` | `F43:=`P |
| `test_check_fails_while_an_old_folder_is_linked` | `F43:=`P |
| `test_an_update_swaps_the_copy_in_place` | `F43:=`P |

**`voice/tests/test_voice_device_recovery.py`**

| Original class / method | Native evidence |
| --- | --- |
| **DeviceRecoveryTests** | |
| `test_audio_table_comments_preserve_the_configured_device` | `F35:=` |
| `test_device_failure_requires_a_ready_stable_device_gate` | `F35:=` |
| `test_default_devices_need_nonzero_channels_and_supported_rates` | `F35:=` |
| `test_a_missing_configured_microphone_never_falls_back_silently` | `E16` |
| `test_device_change_or_removal_resets_the_stability_window` | `F35:=` |
| `test_device_log_class_is_kept_distinct_from_transport_expiry` | `E18` |
| `test_upgrade_catches_only_recent_device_errors_once` | `F37:=` |
| `test_focus_startup_does_not_bypass_device_failure_recovery` | `F36:=` |
| `test_hidden_error_caption_needs_independent_closed_actor_evidence` | `F35:=` |
| `test_corresponding_session_actor_must_confirm_same_pid_and_time` | `E17` |
| `test_confirmed_device_closure_recovers_only_after_preflight` | `F37:=` |

**`voice/tests/test_voice_policy.py`**

| Original class / method | Native evidence |
| --- | --- |
| **OwnDictationTests** | |
| `test_own_speech_that_explains_the_text_passes` | `E15` |
| `test_text_the_gate_never_heard_is_not_the_users` | `E15` |
| `test_speech_from_before_the_recording_does_not_count` | `E15` |
| `test_a_word_of_the_users_cannot_carry_a_long_text` | `E15` |
| `test_another_voice_doing_most_of_the_talking_fails` | `E15` |
| `test_a_short_reply_counts_only_if_it_sounds_like_the_user` | `E15` |
| **DeviceTests** | |
| `test_only_a_headset_records_and_sends` | `F35:=` |
| `test_the_default_input_is_read_without_opening_it` | `F35:=` |
| **SubmitHookTests** | |
| `test_unheard_dictation_is_refused` | `E16` |
| `test_own_dictation_passes` | `E16` |
| `test_a_hand_on_the_keyboard_always_passes` | `E16` |
| `test_messages_from_other_agents_pass` | `E16` |
| `test_a_pane_that_has_not_been_recording_is_left_alone` | `E16` |
| `test_dictation_the_gate_cannot_vouch_for_is_refused` | `E16` |
| `test_a_hand_still_sends_what_the_gate_refuses` | `E16` |

**`voice/tests/test_voice_recovery.py`**

| Original class / method | Native evidence |
| --- | --- |
| **RecoveryPolicyTests** | |
| `test_confirmed_failure_in_a_ready_focused_pane_can_recover` | `E16` |
| `test_healthy_muted_and_listening_calls_are_never_toggled` | `F35:=` |
| `test_missing_footer_without_failure_evidence_is_not_a_disconnect` | `F35:=` |
| `test_user_stop_background_focus_and_a_draft_are_preserved` | `E16` |
| `test_restart_and_rate_limits_prevent_repeated_voice_toggles` | `F35:=` |
| `test_already_restarted_history_is_not_replayed_as_a_new_failure` | `E16` |
| `test_log_reader_uses_exact_metadata_and_does_not_replay_old_events` | `E18` |
| `test_normal_live_tick_sends_no_voice_command` | `F37:=` |
| `test_recovery_requires_fresh_focus_and_confirms_the_new_footer` | `F37:=` |
| `test_focus_change_before_action_cancels_recovery` | `F37:=` |

**`voice/tests/test_voice_settings.py`**

| Original class / method | Native evidence |
| --- | --- |
| **SettingsTests** | |
| `test_no_file_means_general_defaults_and_no_auto_send_microphone` | `F35:=` |
| `test_the_persons_file_overrides_defaults` | `F35:=` |
| `test_wrong_types_and_unknown_keys_are_ignored` | `E20` |
| `test_a_broken_file_falls_back_to_defaults` | `F35:=` |
| `test_update_keeps_other_keys_and_writes_atomically` | `F35:=` |
| `test_device_key_matches_voiceprint_file_names` | `E19` |
| `test_default_path_is_beside_the_app_data` | `F35:=` |

**`voice/tests/test_voicegate_learner.py`**

| Original class / method | Native evidence |
| --- | --- |
| **LearnerTests** | |
| `test_without_a_voiceprint_nothing_is_learned` | `E13` |
| `test_only_speech_that_already_sounds_like_the_user_is_pooled` | `E12` |
| `test_a_new_learner_has_nothing_pending_from_the_old_microphone` | `E12` |
| **CalibrationTests** | |
| `test_a_headset_is_allowed_to_send_and_gets_a_gain_for_its_level` | `F35:=` |
| `test_a_builtin_microphone_is_calibrated_but_not_allowed_to_send` | `F35:=` |
| `test_a_threshold_set_for_the_microphone_wins_over_the_voiceprint` | `F35:=` |

**Dynamic aliases**

Original `CleanupPolicyTests` attaches these six methods from `HarnessRecordTests`; the declaring class is removed by the original source. These are aliases, not new declarations.

| Attached method | Declaring class | Native evidence |
| --- | --- | --- |
| `test_harness_record_precedes_document_and_close_and_closed_follows` | `HarnessRecordTests` | `F27:~` |
| `test_refused_harness_record_keeps_the_space_and_writes_no_document` | `HarnessRecordTests` | `F27:~` |
| `test_unknown_session_id_is_a_reason_to_keep` | `HarnessRecordTests` | `F27:~` |
| `test_user_approval_replaces_the_30_minute_review_after_one_recorded_dry_run` | `HarnessRecordTests` | `F27:~` |
| `test_user_approval_is_tied_to_the_reviewed_code` | `HarnessRecordTests` | `F27:~` |
| `test_claude_input_box_borders_do_not_hide_an_empty_prompt` | `HarnessRecordTests` | `F27:~` |

All 580 declarations have source correspondence. This table makes no claim about execution counts, inherited reruns, test results or platform acceptance.
