# whisper.cpp bundle

`npm run setup:standalone` prepares this bundle before packaging.

If `MEETING_RECORDER_WHISPER_CPP_BINARY` points to an existing platform `whisper-cli`, the setup script copies it into `bin/`. Otherwise it downloads the official whisper.cpp source archive and builds `whisper-cli` with CMake.

Expected default layout:

```text
engines/whisper.cpp/bin/whisper-cli
engines/models/whisper.cpp/ggml-large-v3.bin
```

Use a full precision `large-v3` model for this engine. Quantized models should be treated as a separate speed mode because they can change transcription accuracy.
