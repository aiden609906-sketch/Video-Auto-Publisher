# Douyin Plain-Text Topics Design

Date: 2026-07-21

## Goal

Allow the Douyin workflow to continue when hashtags are present as plain text in the scoped body editor. Selecting a suggestion and producing visible topic chips are no longer success requirements.

## Behavior

1. Submit the video file and verify the selected-file identity.
2. Upload the landscape cover, upload the portrait cover, and confirm the cover editor only after each requested image has a verified visual change.
3. Write and read back the title, then write and read back the body.
4. Select the AI-generated-content declaration and verify the checked value.
5. Normalize, de-duplicate, and cap requested topics at five; append each missing topic as ` #topic` and read every expected token back.
6. Stop after topics and leave the page open for human review and publishing. The workflow does not run a final publish-button check and never clicks publish.

## Safety and Failure Rules

- Do not click a topic suggestion and do not require topic chips.
- Do not click the suggestion overlay or any blank-area dismissal target.
- Guard the route immediately before editor mutation.
- If the editor does not contain every expected topic, return a failed `topics` stage and stop the workflow.
- Error evidence contains only safe counts and booleans, never topic text or post content.

## Fallback

The scoped neutral-click approach failed real pre-publish acceptance. The approved fallback is therefore active: Douyin uploads both covers immediately after submitting the video, then fills title/body, selects the AI declaration, writes topics last, and stops without touching the open suggestion overlay.

## Tests

- The stage succeeds with no suggestion result and no topic chips when all plain-text topics are readable.
- At most five unique topics are written.
- A missing topic fails the stage.
- An opened suggestion overlay is not clicked and does not prevent plain-text topic success.
- The Douyin workflow runs `video → cover → title → body → declaration → topics`.
- Landscape and portrait covers are each uploaded and verified before the cover editor is completed.
- Douyin ends after topics without a `ready` stage.
- Invalid adapter-specific stage orders fail before any stage runs.
- No test or production path clicks the final publish button.
