import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import tiktoken
import pr_guardrails as guard


def inventory(*globs):
    return json.dumps({'schemaVersion': 1, 'patterns': [{'glob': glob} for glob in globs]})


class RepoCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.encoding = tiktoken.get_encoding('o200k_base')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, self.previous)
        self.addCleanup(self.temp.cleanup)
        self.run_git('init', '-q', '-b', 'main')
        self.run_git('config', 'user.email', 'guardrails@example.test')
        self.run_git('config', 'user.name', 'Guardrails tests')
        self.write(guard.MANIFEST, inventory('prompts/*.md'))
        self.write('prompts/base.md', 'hello world\n')
        self.write('package.json', json.dumps({'version': '1.0.0'}))
        self.base = self.save()

    def run_git(self, *args):
        return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode().strip()

    def write(self, path, text):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(text)

    def save(self):
        self.run_git('add', '.')
        self.run_git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
        return self.run_git('rev-parse', 'HEAD')

    def test_counts_added_deleted_and_renamed_prompts_without_executing_them(self):
        self.run_git('mv', 'prompts/base.md', 'prompts/renamed.md')
        self.write('prompts/new.md', 'こんにちは 🌍\n<|endoftext|>\n$(touch SHOULD_NOT_EXIST)')
        self.save()
        data = guard.report(self.base, 'HEAD', self.encoding)
        rows = {row['path']: row for row in data['files']}
        self.assertEqual(rows['prompts/base.md']['change'], 'deleted')
        self.assertEqual(rows['prompts/renamed.md']['change'], 'added')
        text = Path('prompts/new.md').read_text()
        self.assertEqual(rows['prompts/new.md']['after']['tokens'],
                         len(self.encoding.encode(text, disallowed_special=())))
        self.assertEqual(rows['prompts/new.md']['after']['words'], len(text.split()))
        self.assertFalse(Path('SHOULD_NOT_EXIST').exists())

    def test_merge_base_excludes_unrelated_main_changes(self):
        self.run_git('checkout', '-qb', 'candidate')
        self.write('prompts/base.md', 'hello world and more\n')
        head = self.save()
        self.run_git('checkout', '-q', 'main')
        self.write('prompts/unrelated.md', 'new prompt only on main')
        main = self.save()
        data = guard.report(main, head, self.encoding)
        self.assertEqual(data['comparisonSha'], self.base)
        self.assertNotIn('prompts/unrelated.md', [row['path'] for row in data['files']])

    def test_manifest_removal_cannot_hide_a_changed_prompt(self):
        self.write(guard.MANIFEST, inventory('other/*.txt'))
        self.write('prompts/base.md', 'this still counts')
        self.write('other/new.txt', 'newly monitored')
        self.save()
        data = guard.report(self.base, 'HEAD', self.encoding)
        self.assertEqual({row['path'] for row in data['files']}, {'prompts/base.md', 'other/new.txt'})

    def test_symlink_is_rejected_not_followed(self):
        Path('prompts/link.md').symlink_to('/etc/passwd')
        self.save()
        with self.assertRaisesRegex(ValueError, 'regular file'):
            guard.report(self.base, 'HEAD', self.encoding)

    def test_current_main_collision_fails_without_head_changing(self):
        self.write('package.json', json.dumps({'version': '1.0.1'}))
        head = self.save()
        first = guard.report(self.base, head, self.encoding, cli=True)
        self.assertTrue(first['version']['ok'])
        # Another PR lands the same version; candidate SHA is unchanged.
        self.run_git('checkout', '-q', '--detach', self.base)
        self.write('package.json', json.dumps({'version': '1.0.1'}))
        self.write('other.txt', 'a different PR')
        main = self.save()
        second = guard.report(main, head, self.encoding, cli=True)
        self.assertFalse(second['version']['ok'])
        self.assertIn('current main', second['version']['message'])
        self.assertEqual(first['headSha'], second['headSha'])

    def test_committed_lockfile_must_match_package_version(self):
        self.write('package.json', json.dumps({'version': '1.0.1'}))
        self.write('package-lock.json', json.dumps({'version': '1.0.0', 'packages': {'': {'version': '1.0.0'}}}))
        self.save()
        result = guard.report(self.base, 'HEAD', self.encoding, cli=True)
        self.assertFalse(result['version']['ok'])
        self.assertIn('package-lock.json', result['version']['message'])

    def test_report_names_its_encoding_and_handles_no_prompt_changes(self):
        self.write('code.txt', 'not a monitored prompt')
        self.save()
        text = guard.markdown(guard.report(self.base, 'HEAD', self.encoding))
        self.assertIn('No prompt files changed', text)
        self.assertIn('o200k_base', text)
        self.assertIn('not the size of one runtime prompt', text)
        self.assertIn('<kbd>Tokens 0</kbd>', text)

    def test_version_can_compare_main_while_pr_targets_another_branch(self):
        self.write('package.json', json.dumps({'version': '1.0.1'}))
        head = self.save()
        data = guard.report(head, head, self.encoding, cli=True, version_ref=self.base)
        self.assertTrue(data['version']['ok'])
        self.assertEqual(data['versionBaseSha'], self.base)


class SemverTests(unittest.TestCase):
    def test_golden_token_and_word_counts(self):
        self.assertEqual(guard.measures('hello world', tiktoken.get_encoding('o200k_base')),
                         {'tokens': 2, 'words': 2, 'bytes': 11})

    def test_semver_precedence_and_no_build_only_bumps(self):
        for low, high in [('1.0.0', '1.0.1'), ('1.9.0', '1.10.0'), ('1.0.0-alpha.9', '1.0.0-alpha.10'),
                          ('1.0.0-1', '1.0.0-alpha'), ('1.0.0-alpha', '1.0.0-alpha.1'),
                          ('1.0.0-rc.1', '1.0.0')]:
            with self.subTest(low=low, high=high):
                self.assertTrue(guard.version_higher(high, low))
                self.assertFalse(guard.version_higher(low, high))
        self.assertFalse(guard.version_higher('1.0.0+new-build', '1.0.0'))
        self.assertFalse(guard.version_higher('1.0.0', '1.0.0'))

    def test_invalid_versions_and_manifest_paths_fail(self):
        for value in ['v1.0.0', '1.0', '01.0.0', '1.0.0-01', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                guard.semver(value)
        for path in ['/absolute', '../escape', 'path\ncommand', 'windows\\path']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                guard.patterns(inventory(path))


class FakeAPI:
    def __init__(self, comments=None):
        self.calls = []
        self.comments = comments or []
        self.ids = 0

    def request(self, method, path, body):
        self.calls.append((method, path, body))
        self.ids += 1
        return {'id': self.ids}

    def pages(self, path):
        return iter(self.comments)


class RefreshTests(unittest.TestCase):
    def data(self, ok=True):
        zero = {'tokens': 0, 'words': 0, 'bytes': 0}
        return {'headSha': 'a' * 40, 'baseSha': 'b' * 40, 'comparisonSha': 'b' * 40,
                'files': [], 'totals': {'before': zero, 'after': zero},
                'version': {'ok': ok, 'message': 'version outcome'}}

    def snapshot(self, base='b'):
        return ({'state': 'open', 'head': {'sha': 'a' * 40}}, base * 40, base * 40)

    def test_refresh_updates_one_owned_comment_and_fails_colliding_version(self):
        api = FakeAPI([{'id': 9, 'user': {'login': 'github-actions[bot]'}, 'body': guard.MARKER + '\nold'}])
        with patch.object(guard, 'snapshot', return_value=self.snapshot()), \
                patch.object(guard, 'git'), patch.object(guard, 'commit', return_value='a' * 40), \
                patch.object(guard, 'report', return_value=self.data(False)):
            guard.refresh(api, 7, None, True, None)
        conclusions = [b['conclusion'] for m, p, b in api.calls if p.startswith('check-runs/')]
        self.assertEqual(conclusions, ['success', 'failure'])
        self.assertTrue(any(m == 'PATCH' and p == 'issues/comments/9' for m, p, b in api.calls))
        self.assertFalse(any(p == 'issues/7/comments' for m, p, b in api.calls))

    def test_does_not_update_a_human_comment_with_the_same_marker(self):
        api = FakeAPI([{'id': 9, 'user': {'login': 'someone'}, 'body': guard.MARKER}])
        with patch.object(guard, 'snapshot', return_value=self.snapshot()), \
                patch.object(guard, 'git'), patch.object(guard, 'commit', return_value='a' * 40), \
                patch.object(guard, 'report', return_value=self.data()):
            guard.refresh(api, 7, None, True, None)
        self.assertTrue(any(m == 'POST' and p == 'issues/7/comments' for m, p, b in api.calls))

    def test_base_moving_during_report_cancels_stale_checks_and_recalculates(self):
        api = FakeAPI()
        snapshots = [self.snapshot('b'), self.snapshot('c'), self.snapshot('c'), self.snapshot('c')]
        with patch.object(guard, 'snapshot', side_effect=snapshots), patch.object(guard, 'git'), \
                patch.object(guard, 'commit', return_value='a' * 40), \
                patch.object(guard, 'report', side_effect=[self.data(), self.data(False)]) as calculate:
            guard.refresh(api, 7, None, True, None)
        self.assertEqual(calculate.call_count, 2)
        conclusions = [b['conclusion'] for m, p, b in api.calls if p.startswith('check-runs/')]
        self.assertEqual(conclusions, ['cancelled', 'cancelled', 'success', 'failure'])
        self.assertEqual(sum(p == 'issues/7/comments' for m, p, b in api.calls), 1)

    def test_tokenizer_failure_marks_checks_failed_instead_of_reporting_zero(self):
        api = FakeAPI()
        with patch.object(guard, 'snapshot', return_value=self.snapshot()), patch.object(guard, 'git'), \
                patch.object(guard, 'commit', return_value='a' * 40), \
                patch.object(guard, 'report', side_effect=ValueError('encoding unavailable')):
            with self.assertRaisesRegex(ValueError, 'encoding unavailable'):
                guard.refresh(api, 7, None, True, None)
        self.assertEqual([b['conclusion'] for m, p, b in api.calls if p.startswith('check-runs/')],
                         ['failure', 'failure'])
        self.assertFalse(any('comments' in p for m, p, b in api.calls))

    def test_sweep_skips_unchanged_reports_but_manual_refresh_can_force_them(self):
        signature = f'<!-- snapshot: {"b" * 40} {"a" * 40} {"b" * 40} -->'
        api = FakeAPI([{'id': 9, 'user': {'login': 'github-actions[bot]'}, 'body': guard.MARKER + signature}])
        with patch.object(guard, 'snapshot', return_value=self.snapshot()), patch.object(guard, 'git'), \
                patch.object(guard, 'commit', return_value='a' * 40), \
                patch.object(guard, 'report', return_value=self.data()) as calculate:
            self.assertIsNone(guard.refresh(api, 7, None, True, None))
            calculate.assert_not_called()
            guard.refresh(api, 7, None, True, None, force=True)
            calculate.assert_called_once()

    def test_head_changing_during_fetch_retries_without_false_failure(self):
        api = FakeAPI()
        with patch.object(guard, 'snapshot', return_value=self.snapshot()), patch.object(guard, 'git'), \
                patch.object(guard, 'commit', side_effect=['d' * 40, 'a' * 40]), \
                patch.object(guard, 'report', return_value=self.data()) as calculate:
            guard.refresh(api, 7, None, True, None)
        calculate.assert_called_once()
        self.assertEqual([b['conclusion'] for m, p, b in api.calls if p.startswith('check-runs/')],
                         ['cancelled', 'cancelled', 'success', 'success'])


class WorkflowTests(unittest.TestCase):
    def test_a_replaced_pending_pr_event_is_covered_by_the_next_sweep(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as temp:
            try:
                os.chdir(temp)
                Path('.github').mkdir()
                Path(guard.MANIFEST).write_text(inventory())
                api = FakeAPI([{'number': 1}, {'number': 2}])
                with patch('sys.argv', ['pr_guardrails.py', '--github']), \
                        patch.dict(os.environ, {'GITHUB_EVENT_NAME': 'pull_request_target'}, clear=True), \
                        patch.object(guard, 'GitHub', return_value=api), \
                        patch.object(guard, 'refresh', return_value=None) as refresh:
                    guard.main()
                self.assertEqual([call.args[1] for call in refresh.call_args_list], [1, 2])
            finally:
                os.chdir(previous)

    def test_write_workflow_only_runs_default_branch_code(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / '.github/workflows/pr-guardrails.yml').read_text()
        self.assertIn('pull_request_target:', workflow)
        self.assertIn('branches: [main]', workflow)
        self.assertIn('ref: ${{ github.event.repository.default_branch }}', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertNotIn('pull_request.head', workflow)
        self.assertNotIn('pull_request.merge', workflow)

    def test_cli_bootstrap_version_job_uses_candidate_and_main(self):
        root = Path(__file__).resolve().parents[2]
        if not (root / '.github/cli-version-ruleset.json').exists():
            self.skipTest('CLI-specific workflow')
        workflow = (root / '.github/workflows/checks.yml').read_text()
        self.assertIn('--version-only --base origin/main', workflow)
        self.assertIn('git fetch origin main', workflow)
        self.assertIn('pull_request.head.sha', workflow)


if __name__ == '__main__':
    unittest.main()
