# Douyin Plain-Text Topics Design

Date: 2026-07-21

## Goal

Allow the Douyin workflow to continue when hashtags are present as plain text in the scoped body editor. Selecting a suggestion and producing visible topic chips are no longer success requirements.

## Behavior

1. Normalize, de-duplicate, and cap requested topics at five.
2. Append each missing topic to the scoped body editor as ` #topic`.
3. Read the editor back and require every expected normalized plain-text topic to be present.
4. Click one exact, scoped neutral area outside the editor to dismiss the automatically opened suggestion overlay.
5. Require the suggestion overlay to be hidden or detached before returning a successful `topics` stage.
6. Continue with cover, AI declaration, and ready verification. The final publish button remains verification-only and is never clicked.

## Safety and Failure Rules

- Do not click a topic suggestion and do not require topic chips.
- Do not use viewport coordinates, `document.body`, fuzzy text, `force`, or first-match fallbacks for the neutral-area click.
- Guard the route immediately before the click.
- If the editor does not contain every expected topic, or the overlay remains open, return a failed `topics` stage and stop the workflow.
- Error evidence contains only safe counts and booleans, never topic text or post content.

## Fallback

The first implementation preserves the existing stage order as the smallest change. If focused tests or real pre-publish acceptance prove that a scoped neutral click cannot reliably dismiss the overlay, the fallback is a separate design change that moves the Douyin topics stage after cover and AI declaration but before ready verification.

## Tests

- The stage succeeds with no suggestion result and no topic chips when all plain-text topics are readable.
- At most five unique topics are written.
- A missing topic fails the stage.
- An opened suggestion overlay is dismissed through the scoped neutral target before success.
- A persistent overlay fails the stage and prevents cover/declaration execution.
- The workflow continues to cover and declaration after successful plain-text topic verification.
- No test or production path clicks the final publish button.

