# CLAUDE.md

## Git Rules

- Never push directly to `main` branch
- Always create a feature branch for changes
- Use descriptive branch names (e.g., `feature/add-auth`, `fix/webhook-error`)

## Deployment Rules

- **Only use CI/CD for deployments** - never deploy directly using `serverless deploy` or similar commands
- Push changes to a branch and create a PR to trigger CI deployment
- Let CI handle all deployments to AWS

## PR Merge Rules

- **Always ask for user confirmation before merging any PR**
- Once the user agrees to merge a specific PR, that PR can be merged without asking again
- This applies to `gh pr merge` commands
