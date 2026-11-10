"""Read Git blobs as data; never import or execute pull-request content."""
import argparse
import base64
import fnmatch
import html
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

MANIFEST = '.github/prompt-files.json'
MARKER = '<!-- weeny-cloud-pr-guardrails -->'
PROMPT_CHECK = 'Prompt size'
VERSION_CHECK = 'CLI version bump'
MAX_FILE_BYTES = 2_000_000


def git(*args):
    env = os.environ.copy()
    if args and args[0] == 'fetch' and env.get('GH_TOKEN'):
        # checkout does not persist credentials. Keep fetch auth out of argv/logs.
        host = env.get('GITHUB_SERVER_URL', 'https://github.com')
        env.update(GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0=f'http.{host}/.extraheader',
                   GIT_CONFIG_VALUE_0='AUTHORIZATION: basic ' + base64.b64encode(
                       ('x-access-token:' + env['GH_TOKEN']).encode()).decode())
    return subprocess.check_output(['git', *args], env=env)


def commit(ref):
    return git('rev-parse', '--verify', ref + '^{commit}').decode().strip()


class Tree:
    def __init__(self, ref):
        self.sha = commit(ref)
        self.files = {}
        for entry in git('ls-tree', '-rz', '--full-tree', self.sha).split(b'\0'):
            if not entry:
                continue
            metadata, path = entry.split(b'\t', 1)
            mode, kind, sha = metadata.decode().split()
            self.files[path.decode('utf-8')] = (mode, kind, sha)

    def read(self, path):
        entry = self.files.get(path)
        if not entry:
            return None
        mode, kind, sha = entry
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError(f'{path}: tracked prompt/config must be a regular file')
        if int(git('cat-file', '-s', sha)) > MAX_FILE_BYTES:
            raise ValueError(f'{path}: exceeds {MAX_FILE_BYTES} byte measurement limit')
        return git('cat-file', 'blob', sha).decode('utf-8')


def patterns(text):
    if text is None:
        return []
    data = json.loads(text)
    if data.get('schemaVersion') != 1 or not isinstance(data.get('patterns'), list):
        raise ValueError('Prompt manifest must have schemaVersion 1 and a patterns array')
    result = []
    for item in data['patterns']:
        value = item.get('glob') if isinstance(item, dict) else None
        if (not isinstance(value, str) or not value or value.startswith('/')
                or '..' in value.split('/') or any(c in value for c in '\\\r\n\0')):
            raise ValueError('Prompt patterns must be relative, safe POSIX globs')
        result.append(value)
    return result


def measures(text, encoding):
    text = text or ''
    return {'tokens': len(encoding.encode(text, disallowed_special=())),
            'words': len(text.split()), 'bytes': len(text.encode('utf-8'))}


SEMVER = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
                    r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
                    r'(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')


def semver(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError(f'Invalid SemVer version: {value!r}')
    pre = match[4].split('.') if match[4] else []
    if any(p.isdigit() and len(p) > 1 and p[0] == '0' for p in pre):
        raise ValueError(f'Invalid SemVer prerelease: {value!r}')
    return tuple(int(match[i]) for i in (1, 2, 3)), pre


def version_higher(candidate, base):
    core, pre = semver(candidate)
    base_core, base_pre = semver(base)
    if core != base_core:
        return core > base_core
    if not pre or not base_pre:
        return bool(base_pre) and not pre
    for left, right in zip(pre, base_pre):
        if left == right:
            continue
        if left.isdigit() and right.isdigit():
            return int(left) > int(right)
        if left.isdigit() != right.isdigit():
            return not left.isdigit()
        return left > right
    return len(pre) > len(base_pre)


def version_report(base, head):
    result = {'ok': False}
    try:
        base_package = json.loads(base.read('package.json') or '{}')
        package = json.loads(head.read('package.json') or '{}')
        old, new = base_package.get('version'), package.get('version')
        result.update(base=old, head=new)
        if not version_higher(new, old):
            raise ValueError(f'Bump package.json above current main ({old}); PR has {new}.')
        for path in ('package-lock.json', 'npm-shrinkwrap.json'):
            text = head.read(path)
            if text is not None:
                lock = json.loads(text)
                versions = [lock.get('version')]
                if '' in lock.get('packages', {}):
                    versions.append(lock['packages']['']['version'])
                if any(value != new for value in versions):
                    raise ValueError(f'{path} version must match package.json ({new}).')
        result.update(ok=True, message=f'{old} → {new}: version is higher than current main.')
    except (ValueError, KeyError, TypeError) as error:
        result['message'] = str(error)
    return result


def report(base_ref, head_ref, encoding, cli=False, trusted_manifest=None, version_ref=None):
    base, head = Tree(base_ref), Tree(head_ref)
    ancestor = Tree(git('merge-base', base.sha, head.sha).decode().strip())
    # Use the union, so deleting an inventory entry cannot hide that PR's prompt changes.
    globs = set(patterns(ancestor.read(MANIFEST)) + patterns(head.read(MANIFEST))
                + patterns(trusted_manifest))
    paths = sorted(p for p in ancestor.files.keys() | head.files.keys()
                   if any(fnmatch.fnmatchcase(p, pattern) for pattern in globs))
    files = []
    for path in paths:
        before, after = ancestor.read(path), head.read(path)
        files.append({'path': path, 'before': measures(before, encoding),
                      'after': measures(after, encoding), 'changed': before != after,
                      'change': 'added' if before is None else 'deleted' if after is None else 'modified'})
    totals = {side: {key: sum(f[side][key] for f in files) for key in ('tokens', 'words', 'bytes')}
              for side in ('before', 'after')}
    version_base = Tree(version_ref) if version_ref else base
    return {'baseSha': base.sha, 'headSha': head.sha, 'comparisonSha': ancestor.sha,
            'versionBaseSha': version_base.sha,
            'encoding': 'o200k_base', 'files': files, 'totals': totals,
            'version': version_report(version_base, head) if cli else None}


def signed(value):
    return f'{value:+,}' if value else '0'


def delta(data, key):
    return data['after'][key] - data['before'][key]


def safe(value, limit=1000):
    return html.escape(str(value)[:limit]).replace('|', '&#124;').replace('`', '&#96;').replace('@', '&#64;').replace('\n', ' ')


def markdown(data):
    totals = data['totals']
    lines = [MARKER, '### Prompt size', '',
             f'<kbd>Tokens {signed(delta(totals, "tokens"))}</kbd> '
             f'<kbd>Words {signed(delta(totals, "words"))}</kbd>', '',
             f'Inventory total: **{totals["before"]["tokens"]:,} → {totals["after"]["tokens"]:,} tokens**, '
             f'**{totals["before"]["words"]:,} → {totals["after"]["words"]:,} words**.', '',
             f'PR `{data["headSha"][:12]}` · current base `{data["baseSha"][:12]}` · '
             f'PR comparison/merge-base `{data["comparisonSha"][:12]}`.', '',
             'Exact **o200k_base** file-token counts; words are whitespace-separated. '
             'Whole files are measured (including code/schema in mixed source files). '
             'Totals include tracked mirrors and are not the size of one runtime prompt.', '',
             '| Changed prompt file | Tokens before → after | Δ tokens | Words before → after | Δ words |',
             '| --- | ---: | ---: | ---: | ---: |']
    changed = [f for f in data['files'] if f['changed']]
    for item in changed[:100]:
        lines.append(f'| {safe(item["path"], 200)} ({item["change"]}) | '
                     f'{item["before"]["tokens"]:,} → {item["after"]["tokens"]:,} | '
                     f'{signed(delta(item, "tokens"))} | '
                     f'{item["before"]["words"]:,} → {item["after"]["words"]:,} | '
                     f'{signed(delta(item, "words"))} |')
    if not changed:
        lines.append('| No prompt files changed | — | 0 | — | 0 |')
    if len(changed) > 100:
        lines.extend(['', f'{len(changed) - 100} further changed files omitted from this table; '
                      'the workflow JSON artifact contains every row. Totals include all files.'])
    lines.extend(['', f'Inventory: **{len(data["files"])} files** selected by `{MANIFEST}` '
                  '(union of base and PR patterns). Add newly introduced prompt locations to that list.'])
    if data['version'] is not None:
        version = data['version']
        lines.extend(['', '### CLI version bump', '',
                      ('✅ ' if version['ok'] else '❌ ') + safe(version['message']), '',
                      'Compared with current main, not the PR merge-base. Refreshed when main advances.'])
    return '\n'.join(lines) + '\n'


class GitHub:
    def __init__(self):
        self.root = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
        self.repo = os.environ['GITHUB_REPOSITORY']
        self.token = os.environ['GH_TOKEN']

    def request(self, method, path, body=None):
        request = Request(self.root + '/repos/' + self.repo + '/' + path,
                          data=json.dumps(body).encode() if body is not None else None,
                          method=method, headers={'Authorization': 'Bearer ' + self.token,
                          'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json',
                          'X-GitHub-Api-Version': '2022-11-28'})
        with urlopen(request, timeout=60) as response:
            return json.load(response)

    def pages(self, path):
        page = 1
        while True:
            rows = self.request('GET', path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
            yield from rows
            if len(rows) < 100:
                break
            page += 1


def snapshot(api, number):
    pr = api.request('GET', f'pulls/{number}')
    base = api.request('GET', 'git/ref/heads/' + quote(pr['base']['ref'], safe=''))['object']['sha']
    main = base if pr['base']['ref'] == 'main' else api.request('GET', 'git/ref/heads/main')['object']['sha']
    return pr, base, main


def check(api, sha, name):
    return api.request('POST', 'check-runs', {'name': name, 'head_sha': sha, 'status': 'in_progress'})['id']


def complete(api, check_id, conclusion, title, summary):
    api.request('PATCH', f'check-runs/{check_id}', {'status': 'completed', 'conclusion': conclusion,
                'output': {'title': title[:255], 'summary': summary[:65000]}})


def refresh(api, number, encoding, cli, trusted_manifest, force=False):
    for attempt in range(3):
        pr, base, main_sha = snapshot(api, number)
        if pr['state'] != 'open':
            return None
        sha = pr['head']['sha']
        signature = f'<!-- snapshot: {base} {sha} {main_sha} -->'
        existing = next((c for c in api.pages(f'issues/{number}/comments')
                         if c.get('user', {}).get('login') == 'github-actions[bot]'
                         and c.get('body', '').startswith(MARKER)), None)
        if not force and existing and signature in existing['body']:
            return None
        checks = [(PROMPT_CHECK, check(api, sha, PROMPT_CHECK))]
        if cli:
            checks.append((VERSION_CHECK, check(api, sha, VERSION_CHECK)))
        try:
            git('fetch', '--no-tags', 'origin', base)
            if cli and main_sha != base:
                git('fetch', '--no-tags', 'origin', main_sha)
            git('fetch', '--no-tags', 'origin', f'+refs/pull/{number}/head:refs/guardrails/pr-{number}')
            actual = commit(f'refs/guardrails/pr-{number}')
            if actual != sha:
                for name, check_id in checks:
                    complete(api, check_id, 'cancelled', 'Superseded snapshot', 'PR changed while fetching; checking its latest head.')
                continue
            data = report(base, sha, encoding, cli, trusted_manifest, main_sha if cli else None)
            latest, latest_base, latest_main = snapshot(api, number)
            if (latest['head']['sha'] != sha or latest_base != base or latest['state'] != 'open'
                    or cli and latest_main != main_sha):
                for name, check_id in checks:
                    complete(api, check_id, 'cancelled', 'Superseded snapshot', 'A newer base or PR revision is being checked.')
                continue
            body = markdown(data).replace(MARKER, MARKER + '\n' + signature, 1)
            for name, check_id in checks:
                if name == PROMPT_CHECK:
                    title = f'Tokens {signed(delta(data["totals"], "tokens"))} · Words {signed(delta(data["totals"], "words"))}'
                    complete(api, check_id, 'success', title, body)
                else:
                    version = data['version']
                    complete(api, check_id, 'success' if version['ok'] else 'failure', version['message'], body)
            if existing:
                api.request('PATCH', f'issues/comments/{existing["id"]}', {'body': body})
            else:
                api.request('POST', f'issues/{number}/comments', {'body': body})
            return data
        except Exception as error:
            for name, check_id in checks:
                complete(api, check_id, 'failure', 'Guardrail could not complete', safe(str(error)))
            raise
    raise RuntimeError(f'PR #{number} kept changing; no stale success was published. Rerun the workflow.')


class Tokenizer:
    def encode(self, text, **kwargs):
        # Load only after per-PR checks are pending, so tokenization errors fail closed.
        if not hasattr(self, 'encoding'):
            import tiktoken
            self.encoding = tiktoken.get_encoding('o200k_base')
        return self.encoding.encode(text, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='origin/main')
    parser.add_argument('--head', default='HEAD')
    parser.add_argument('--cli-version', action='store_true')
    parser.add_argument('--version-only', action='store_true')
    parser.add_argument('--github', action='store_true')
    args = parser.parse_args()
    if args.version_only:
        result = version_report(Tree(args.base), Tree(args.head))
        print(result['message'])
        return 0 if result['ok'] else 1
    encoding = Tokenizer()
    trusted = Path(MANIFEST).read_text()
    if not args.github:
        data = report(args.base, args.head, encoding, args.cli_version, trusted,
                      'origin/main' if args.cli_version else None)
        print(markdown(data))
        return 1 if data['version'] and not data['version']['ok'] else 0
    api = GitHub()
    # Concurrency groups can replace older pending runs. Sweeping all open PRs
    # means the newest run also handles PR events whose pending run was replaced.
    numbers = [p['number'] for p in api.pages('pulls?state=open')]
    results, failures = [], []
    for number in numbers:
        try:
            data = refresh(api, number, encoding, args.cli_version, trusted,
                           force=os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch')
            if data:
                results.append(data)
        except Exception as error:
            # Keep refreshing the remaining PRs if one is broken.
            failures.append(f'PR #{number}: {error}')
    Path('pr-guardrails.json').write_text(json.dumps(results, indent=2) + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            for data in results:
                summary.write(markdown(data))
    if failures:
        raise RuntimeError('\n'.join(failures))
    return 0


if __name__ == '__main__':
    sys.exit(main())
