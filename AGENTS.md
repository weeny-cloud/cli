# Release workflow

Push every change as a GitHub PR and test the unpublished candidate against isolated
Weeny staging before release. Record the candidate revisions and test results.
Address review findings and let the user review/merge. Publishing npm or deploying
production requires separate explicit release approval; merging alone is not an
instruction to publish. Never use production as a development test environment.

Use WEENY_ENV=staging, WEENY_API=https://staging.weeny.cloud and a separate
WEENY_CONFIG_DIR for all acceptance work. Invoke the candidate cli.mjs directly,
not the public npm release. Keep the shared feedback helper/tests in sync with
vm/feedback.mjs and vm/feedback.test.mjs in the platform repository.

# Owner email

- `theomccabe@bpp.com` is Theo's employer/work email, not his business email. Never use it for Weeny accounts, notifications, billing, test accounts, examples, or service registrations. Nothing related to Weeny should be sent there.
- The existing Weeny owner/support address is `theomccabe@mac.com`; ask Theo before substituting a different business address.
