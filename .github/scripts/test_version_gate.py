import contextlib
import io
import json
import subprocess
import unittest
from unittest.mock import patch

import enable_version_gate as gate


class VersionGateSetupTests(unittest.TestCase):
    def test_dry_run_does_not_contact_or_change_github(self):
        with patch('sys.argv', ['enable_version_gate.py']), \
                patch.object(gate.subprocess, 'run') as run, \
                patch.object(gate.subprocess, 'check_output') as read, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            gate.main()
        run.assert_not_called()
        read.assert_not_called()
        self.assertIn('Dry run', output.getvalue())

    def test_apply_stops_before_changing_rules_when_workflow_is_not_live(self):
        with patch('sys.argv', ['enable_version_gate.py', '--apply']), \
                patch.object(gate.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'gh')) as run, \
                patch.object(gate.subprocess, 'check_output') as read:
            with self.assertRaises(subprocess.CalledProcessError):
                gate.main()
        self.assertEqual(run.call_count, 1)
        self.assertIn('contents/.github/workflows/pr-guardrails.yml?ref=main', run.call_args.args[0][-1])
        read.assert_not_called()

    def test_updates_only_its_own_rule_and_preserves_existing_review_rules(self):
        rules = [[{'id': 10, 'name': 'Existing review policy', 'source': 'weeny-cloud/cli'},
                  {'id': 11, 'name': 'CLI version must exceed main', 'source': 'weeny-cloud/cli'}]]
        with patch('sys.argv', ['enable_version_gate.py', '--apply']), \
                patch.object(gate.subprocess, 'run') as run, \
                patch.object(gate.subprocess, 'check_output', return_value=json.dumps(rules).encode()):
            gate.main()
        argv = run.call_args.args[0]
        self.assertIn('PUT', argv)
        self.assertIn('repos/weeny-cloud/cli/rulesets/11', argv)
        body = json.loads(run.call_args.kwargs['input'])
        self.assertTrue(body['rules'][0]['parameters']['strict_required_status_checks_policy'])
        self.assertEqual(body['rules'][0]['parameters']['required_status_checks'],
                         [{'context': 'CLI version bump'}])
        self.assertEqual(body['bypass_actors'], [])


if __name__ == '__main__':
    unittest.main()
