#!/usr/bin/env python3
"""
PostToolUse hook to save approved PR numbers after successful merge attempt.
This allows the same PR to be merged again without asking (for CI retry loops).
"""
import json
import sys
import os
import re

APPROVED_PRS_FILE = os.path.join(os.path.dirname(__file__), ".approved_prs")

def save_approved_pr(pr_number):
    """Add PR number to the approved list."""
    approved = set()
    if os.path.exists(APPROVED_PRS_FILE):
        with open(APPROVED_PRS_FILE, "r") as f:
            approved = set(line.strip() for line in f if line.strip())

    approved.add(pr_number)

    with open(APPROVED_PRS_FILE, "w") as f:
        f.write("\n".join(sorted(approved)) + "\n")

def extract_pr_number(command):
    """Extract PR number from gh pr merge command."""
    match = re.search(r'gh pr merge\s+#?(\d+)', command)
    if match:
        return match.group(1)
    match = re.search(r'gh pr merge\s+\S*?/pull/(\d+)', command)
    if match:
        return match.group(1)
    return None

try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})
command = tool_input.get("command", "")

# Save approved PR after gh pr merge command runs
if tool_name == "Bash" and "gh pr merge" in command:
    pr_number = extract_pr_number(command)
    if pr_number:
        save_approved_pr(pr_number)

sys.exit(0)
