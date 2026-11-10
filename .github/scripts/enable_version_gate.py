"""Enable the CLI version rule after its workflow has landed on main."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Apply using your existing gh admin login')
    args = parser.parse_args()
    repo = 'weeny-cloud/cli'
    root = Path(__file__).resolve().parents[2]
    rule = json.loads((root / '.github/cli-version-ruleset.json').read_text())
    if not args.apply:
        print(json.dumps(rule, indent=2))
        print('Dry run. After this PR merges, rerun with --apply to enable the required gate.')
        return
    # Do not block every PR with a required check that does not exist on main yet.
    subprocess.run(['gh', 'api', f'repos/{repo}/contents/.github/workflows/pr-guardrails.yml?ref=main'],
                   check=True, stdout=subprocess.DEVNULL)
    rules = json.loads(subprocess.check_output(['gh', 'api', '--paginate', '--slurp',
                                               f'repos/{repo}/rulesets?per_page=100']))
    matches = [item for page in rules for item in page
               if item['name'] == rule['name'] and item.get('source') == repo]
    if len(matches) > 1:
        raise RuntimeError('Multiple matching rulesets; inspect them before proceeding')
    path = f'repos/{repo}/rulesets' + (f'/{matches[0]["id"]}' if matches else '')
    subprocess.run(['gh', 'api', '--method', 'PUT' if matches else 'POST', path, '--input', '-'],
                   input=json.dumps(rule).encode(), check=True)


if __name__ == '__main__':
    main()
