# VOXTASK

Voice → transcript → structured tasks, now with a first design pass for the recording interface.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and set `GROQ_API_KEY` to a free Groq API key.
4. Run `npm run dev` and open `http://localhost:3000`.

The API key stays on the server. Do not put it in a `NEXT_PUBLIC_` variable or commit `.env.local`.

## Test the pipeline

- Choose an **Input device** before recording. Use **Refresh devices** to request microphone access and reveal device names. The selected device is used for the recorded audio.
- **Start recording** shows browser speech recognition as you talk where it works. If browser speech fails, or you choose a non-default input, Whisper Large V3 Turbo updates a draft transcript from recorded audio about every four seconds. When you stop, Whisper Large V3 transcribes the full recording for the final text. Browser speech recognition uses the browser's default input.
- Add names and acronyms to **Vocabulary hints** before recording to help Whisper spell them. Compare the live Turbo and final V3 versions when they differ, then choose or edit the better text. **Retry Whisper V3** runs the full model again on the saved recording. The audio player lets you check whether the chosen input captured clean speech; **Download clip** saves the recording for closer debugging.
- **Stop** preserves the audio recording. **Transcribe with Whisper** sends it to Groq for a second transcription path. Browser speech may use a browser vendor service and may not work offline.
- You can type or load a sample transcript, then select **Extract tasks**. Groq returns strict JSON, and the server checks task fields and source fragments before showing them.
- Edit fields on the cards and inspect raw JSON and timings. Task edits stay in browser memory only.
- The animated circle is the main Start/Stop control. It assembles before the navigation appears, then its outer color segments rotate while the center moves slowly. Scroll to tasks or return with task history and the circle docks at the lower right. Save reviewed results to task history; this history stays in the browser's local storage.

Spoken constraints such as “before class” and “Friday evening” are kept in `dueTimeText`; `dueTime` stays empty until an actual clock time is spoken or confirmed. A weekend is kept in `dueDateText` without inventing a single date.

Confidence calibration starts with the **Calibration reviews** panel. Correct the extracted cards, enter the number of missed tasks, and save the review. The browser stores each original prediction and correction locally; reviewing the same transcript and date again replaces its prior entry. Export the JSON file to back up or inspect labels. The panel reports title, date/time, and priority accuracy plus a 95% Wilson interval for the current extraction model. A title score needs 30 reviewed extracted tasks; date/time and priority scores also need 30 reviews in the relevant output group. Before then the corresponding `confidence` value remains `null`. These rates are group averages, not per-task probabilities. Missed tasks are counted separately and are not included in title accuracy. Recalibrate when the model or extraction rules change.

Microphone capture requires `localhost` or HTTPS. The app does not silently generate sample AI results when the key is absent; the page shows a clear configuration error. The free plan is rate limited, so check [Groq's current limits](https://console.groq.com/docs/rate-limits) before a demo.

## Core scope

Included: microphone recording, interim browser transcript, Whisper fallback, AI extraction, server validation, source traceability, editable task cards, raw JSON, and timing metrics.

Later: benchmark with real speech samples, improve date and dependency handling, account-backed persistence, Kanban, calendar export, and further interface refinement.

Run `npm test` for validation checks and `npm run build` for the production build.

## Stitch design connection

Add `STITCH_API_KEY` to `.env.local` from your Stitch account settings, then run `npm run stitch:check`. This uses Google's Stitch SDK to verify access without printing the key. The SDK is a development dependency; it is not included in the VOXTASK browser UI. Keep `.env.local` private.

The first Stitch screen is recorded in `design/stitch-project.json`; the source brief is `design/stitch-brief.md`. The live record animation is implemented locally with Anime.js so its entrance, looping rings, reduced-motion behavior, and button states remain under app control.
