# whisper.cpp bundle

`npm run setup:standalone` prepares this bundle before packaging.

If `MEETING_RECORDER_WHISPER_CPP_BINARY` points to an existing platform `whisper-cli`, the setup script copies it into `bin/`. Otherwise it downloads the official whisper.cpp source archive and builds `whisper-cli` with CMake.

Expected default layout:

```text
engines/whisper.cpp/bin/whisper-cli
engines/models/whisper.cpp/ggml-large-v3.bin
```

Use a full precision `large-v3` model for this engine. Quantized models should be treated as a separate speed mode because they can change transcription accuracy.

Whisper is an encoder-decoder model, not a CTC model. This app runs whisper.cpp in a literal, token-timestamp-oriented mode by default: JSON-full output, beam search, DTW token timestamps, no temperature fallback, and no previous-text context for non-contextual transcription.

The default `ggml-large-v3.bin` model maps to the whisper.cpp `large.v3` DTW preset. Set `MEETING_RECORDER_WHISPER_CPP_DTW_PRESET` if you use another whisper.cpp model and need to override the inferred preset.
