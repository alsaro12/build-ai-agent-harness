---
description: Patterns and pitfalls for adding authentication to this project
---

# Auth Patterns

Use this skill when a task asks for authentication, OAuth, login, sessions, route protection, or user identity.

## Current Project

This harness is a CLI agent project, not a web application. It does not currently include auth routes, middleware, user tables, or a session store.

## Guidance

- Search the project before adding auth files.
- Do not assume NextAuth, Clerk, Auth0, or custom JWTs are already installed.
- Ask the user which auth provider or strategy they want before adding dependencies.
- Do not modify `.env` files directly.
- If auth is out of scope for the current repo, explain the missing application surface before implementing.

## Verification

After auth-related changes, run the discovered verification gates and report exact results.
