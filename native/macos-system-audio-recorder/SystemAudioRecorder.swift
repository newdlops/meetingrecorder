import AVFoundation
import AudioToolbox
import CoreAudio
import CoreMedia
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit

enum RecorderError: Error {
    case missingOutputPath
    case noDisplay
    case noContentOnDisplay
    case writerInputRejected
    case coreAudioError(String, OSStatus)
    case unsupportedTapFormat(String)
}

protocol SystemAudioRecording {
    func start() async throws
    func stop() async
}

@available(macOS 14.2, *)
private let processTapIOProc: AudioDeviceIOProc = { _, _, inputData, _, _, _, clientData in
    guard let clientData else {
        return noErr
    }

    let recorder = Unmanaged<ProcessTapSystemAudioRecorder>.fromOpaque(clientData).takeUnretainedValue()
    recorder.handleInput(inputData)
    return noErr
}

@available(macOS 14.2, *)
final class ProcessTapSystemAudioRecorder: SystemAudioRecording, @unchecked Sendable {
    private let outputURL: URL
    private let writeQueue = DispatchQueue(label: "meeting-recorder.system-audio.tap-writer")
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var fileHandle: FileHandle?
    private var inputFormat = AudioStreamBasicDescription()
    private var sampleRate = 48_000
    private var channelCount = 2
    private var dataByteCount: UInt32 = 0
    private var callbackCount = 0
    private var chunkCount = 0
    private var droppedBufferCount = 0
    private var unsupportedFormatMessage: String?

    init(outputPath: String) {
        self.outputURL = URL(fileURLWithPath: outputPath)
    }

    func start() async throws {
        let tapDescription = CATapDescription()
        tapDescription.name = "Meeting Recorder System Output"
        tapDescription.uuid = UUID()
        tapDescription.processes = []
        tapDescription.isExclusive = true
        tapDescription.isMixdown = true
        tapDescription.isMono = false
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = CATapMuteBehavior.unmuted

        try check(AudioHardwareCreateProcessTap(tapDescription, &tapID), "process tap 생성")
        let tapUID = tapDescription.uuid.uuidString
        let aggregateUID = "com.meetingrecorder.system-audio-recorder.aggregate.\(UUID().uuidString)"
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meeting Recorder System Output",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true
            ]]
        ]

        try check(
            AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateDeviceID),
            "process tap aggregate device 생성"
        )
        inputFormat = readInputFormat() ?? defaultInputFormat()
        sampleRate = max(1, Int(inputFormat.mSampleRate.rounded()))
        channelCount = max(1, Int(inputFormat.mChannelsPerFrame))
        try prepareOutputFile()

        try check(
            AudioDeviceCreateIOProcID(
                aggregateDeviceID,
                processTapIOProc,
                Unmanaged.passUnretained(self).toOpaque(),
                &ioProcID
            ),
            "process tap IOProc 생성"
        )
        try check(AudioDeviceStart(aggregateDeviceID, ioProcID), "process tap 시작")
        emit([
            "type": "diagnostic",
            "message": "coreaudio process tap started sampleRate=\(sampleRate), channels=\(channelCount), formatFlags=\(inputFormat.mFormatFlags)"
        ])
    }

    func stop() async {
        if aggregateDeviceID != kAudioObjectUnknown, let ioProcID {
            _ = AudioDeviceStop(aggregateDeviceID, ioProcID)
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }

        writeQueue.sync {
            finalizeOutputFile()
        }

        if aggregateDeviceID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }

        if tapID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }

        if let unsupportedFormatMessage {
            emit(["type": "error", "message": unsupportedFormatMessage])
        }

        emit([
            "type": "done",
            "sampleBuffers": callbackCount,
            "appendedBuffers": chunkCount,
            "droppedBuffers": droppedBufferCount
        ])
    }

    fileprivate func handleInput(_ inputData: UnsafePointer<AudioBufferList>?) {
        callbackCount += 1

        guard let inputData else {
            droppedBufferCount += 1
            return
        }

        guard let chunk = makeInterleavedFloatData(from: inputData), !chunk.isEmpty else {
            droppedBufferCount += 1
            return
        }

        chunkCount += 1
        writeQueue.async { [weak self] in
            guard let self, let fileHandle = self.fileHandle else {
                return
            }

            fileHandle.write(chunk)
            self.dataByteCount = self.dataByteCount &+ UInt32(chunk.count)
        }
    }

    private func readInputFormat() -> AudioStreamBasicDescription? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(aggregateDeviceID, &address, 0, nil, &size, &format)

        return status == noErr ? format : nil
    }

    private func defaultInputFormat() -> AudioStreamBasicDescription {
        AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian,
            mBytesPerPacket: 8,
            mFramesPerPacket: 1,
            mBytesPerFrame: 8,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 32,
            mReserved: 0
        )
    }

    private func prepareOutputFile() throws {
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        fileHandle = try FileHandle(forWritingTo: outputURL)
        fileHandle?.write(makeFloatWavHeader(dataSize: 0))
    }

    private func finalizeOutputFile() {
        guard let fileHandle else {
            return
        }

        do {
            try fileHandle.seek(toOffset: 0)
            fileHandle.write(makeFloatWavHeader(dataSize: dataByteCount))
            try fileHandle.close()
            self.fileHandle = nil
        } catch {
            emit(["type": "error", "message": "시스템 오디오 파일 마무리 실패: \(error)"])
        }
    }

    private func makeInterleavedFloatData(from audioBufferList: UnsafePointer<AudioBufferList>) -> Data? {
        let flags = inputFormat.mFormatFlags
        let isFloat32 = inputFormat.mFormatID == kAudioFormatLinearPCM &&
            (flags & kAudioFormatFlagIsFloat) != 0 &&
            inputFormat.mBitsPerChannel == 32

        guard isFloat32 else {
            unsupportedFormatMessage = "지원하지 않는 CoreAudio tap 포맷입니다. formatID=\(inputFormat.mFormatID), flags=\(flags), bits=\(inputFormat.mBitsPerChannel)"
            return nil
        }

        let buffers = audioBuffers(from: audioBufferList)
        guard let firstBuffer = buffers.first, firstBuffer.mData != nil else {
            return nil
        }

        let isNonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0 || buffers.count > 1
        let bytesPerSample = MemoryLayout<Float32>.size
        let frames = isNonInterleaved
            ? Int(firstBuffer.mDataByteSize) / bytesPerSample
            : Int(firstBuffer.mDataByteSize) / max(1, channelCount * bytesPerSample)

        guard frames > 0 else {
            return nil
        }

        if !isNonInterleaved, firstBuffer.mNumberChannels == channelCount {
            return Data(bytes: firstBuffer.mData!, count: frames * channelCount * bytesPerSample)
        }

        var data = Data(count: frames * channelCount * bytesPerSample)
        data.withUnsafeMutableBytes { rawBuffer in
            let output = rawBuffer.bindMemory(to: Float32.self)

            for frame in 0..<frames {
                for channel in 0..<channelCount {
                    let sourceChannel = min(channel, buffers.count - 1)
                    let sourceBuffer = buffers[sourceChannel]
                    let sample = sourceBuffer.mData?.assumingMemoryBound(to: Float32.self)[frame] ?? 0
                    output[frame * channelCount + channel] = sample
                }
            }
        }

        return data
    }

    private func audioBuffers(from audioBufferList: UnsafePointer<AudioBufferList>) -> [AudioBuffer] {
        let bufferCount = Int(audioBufferList.pointee.mNumberBuffers)
        let buffersOffset = MemoryLayout<AudioBufferList>.offset(of: \.mBuffers) ?? MemoryLayout<UInt32>.size
        let bufferPointer = UnsafeRawPointer(audioBufferList)
            .advanced(by: buffersOffset)
            .assumingMemoryBound(to: AudioBuffer.self)

        return (0..<bufferCount).map { bufferPointer[$0] }
    }

    private func makeFloatWavHeader(dataSize: UInt32) -> Data {
        let bitsPerSample: UInt16 = 32
        let bytesPerSample: UInt16 = bitsPerSample / 8
        let channelCountValue = UInt16(max(1, channelCount))
        let sampleRateValue = UInt32(max(1, sampleRate))
        let blockAlign = channelCountValue * bytesPerSample
        let byteRate = sampleRateValue * UInt32(blockAlign)
        var data = Data()

        appendAscii("RIFF", to: &data)
        appendUInt32(36 &+ dataSize, to: &data)
        appendAscii("WAVE", to: &data)
        appendAscii("fmt ", to: &data)
        appendUInt32(16, to: &data)
        appendUInt16(3, to: &data)
        appendUInt16(channelCountValue, to: &data)
        appendUInt32(sampleRateValue, to: &data)
        appendUInt32(byteRate, to: &data)
        appendUInt16(blockAlign, to: &data)
        appendUInt16(bitsPerSample, to: &data)
        appendAscii("data", to: &data)
        appendUInt32(dataSize, to: &data)

        return data
    }

    private func appendAscii(_ value: String, to data: inout Data) {
        data.append(contentsOf: value.utf8)
    }

    private func appendUInt16(_ value: UInt16, to data: inout Data) {
        var littleEndian = value.littleEndian
        data.append(Data(bytes: &littleEndian, count: MemoryLayout<UInt16>.size))
    }

    private func appendUInt32(_ value: UInt32, to data: inout Data) {
        var littleEndian = value.littleEndian
        data.append(Data(bytes: &littleEndian, count: MemoryLayout<UInt32>.size))
    }

    private func check(_ status: OSStatus, _ action: String) throws {
        guard status == noErr else {
            throw RecorderError.coreAudioError(action, status)
        }
    }
}

@available(macOS 13.0, *)
final class ScreenCaptureKitSystemAudioRecorder: NSObject, SystemAudioRecording, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private let outputURL: URL
    private let sampleQueue = DispatchQueue(label: "meeting-recorder.system-audio.samples")
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var didStartWriting = false
    private var sampleBufferCount = 0
    private var appendedBufferCount = 0
    private var droppedBufferCount = 0

    init(outputPath: String) {
        self.outputURL = URL(fileURLWithPath: outputPath)
    }

    // 화면 픽셀은 저장하지 않고 시스템 오디오 샘플 출력만 구독한다.
    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = selectDisplay(from: content) else {
            throw RecorderError.noDisplay
        }

        let excludedApplications = content.applications.filter { application in
            application.processID == getpid() || excludedBundleIds.contains(application.bundleIdentifier)
        }
        let filter = SCContentFilter(
            display: display,
            excludingApplications: excludedApplications,
            exceptingWindows: []
        )
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let nextStream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try nextStream.addStreamOutput(self, type: SCStreamOutputType.audio, sampleHandlerQueue: sampleQueue)
        stream = nextStream
        writer = try AVAssetWriter(outputURL: outputURL, fileType: .wav)
        try await nextStream.startCapture()
        emit([
            "type": "diagnostic",
            "message": "capturing display=\(display.displayID), excludedApps=\(excludedApplications.map(\.bundleIdentifier).joined(separator: ","))"
        ])
    }

    // 캡처를 멈추고 AVAssetWriter가 WAV 헤더를 마무리할 때까지 기다린다.
    func stop() async {
        try? await stream?.stopCapture()
        await withCheckedContinuation { continuation in
            sampleQueue.async {
                guard let writer = self.writer, self.didStartWriting else {
                    self.writeEmptyWavIfNeeded()
                    continuation.resume()
                    return
                }

                self.input?.markAsFinished()
                writer.finishWriting {
                    continuation.resume()
                }
            }
        }
        emit([
            "type": "done",
            "sampleBuffers": sampleBufferCount,
            "appendedBuffers": appendedBufferCount,
            "droppedBuffers": droppedBufferCount
        ])
    }

    // ScreenCaptureKit이 넘긴 오디오 sample buffer를 WAV writer에 순서대로 추가한다.
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else {
            return
        }

        do {
            sampleBufferCount += 1
            try prepareWriterInputIfNeeded(sampleBuffer)
            guard let writer, let input, input.isReadyForMoreMediaData else {
                droppedBufferCount += 1
                return
            }

            if !didStartWriting {
                writer.startWriting()
                writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
                didStartWriting = true
            }

            if input.append(sampleBuffer) {
                appendedBufferCount += 1
            } else {
                droppedBufferCount += 1
                let writerError = writer.error.map { "\($0)" } ?? "unknown writer error"
                emit(["type": "error", "message": "오디오 샘플을 WAV writer에 추가하지 못했습니다. \(writerError)"])
            }
        } catch {
            emit(["type": "error", "message": "\(error)"])
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["type": "error", "message": "\(error)"])
    }

    // 첫 오디오 샘플의 포맷을 기준으로 WAV writer input을 만든다.
    private func prepareWriterInputIfNeeded(_ sampleBuffer: CMSampleBuffer) throws {
        if input != nil {
            return
        }

        guard
            let writer,
            let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
            let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
        else {
            throw RecorderError.writerInputRejected
        }

        let channelCount = max(1, Int(streamDescription.pointee.mChannelsPerFrame))
        let sampleRate = max(16_000, streamDescription.pointee.mSampleRate)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: channelCount,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        let nextInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        nextInput.expectsMediaDataInRealTime = true

        guard writer.canAdd(nextInput) else {
            throw RecorderError.writerInputRejected
        }

        writer.add(nextInput)
        input = nextInput
    }

    // 녹음이 너무 짧아 샘플이 없을 때도 앱이 읽을 수 있는 빈 WAV를 남긴다.
    private func writeEmptyWavIfNeeded() {
        guard !FileManager.default.fileExists(atPath: outputURL.path) else {
            return
        }

        let header: [UInt8] = [
            0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
            0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
            0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
            0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
            0x00, 0x00, 0x00, 0x00
        ]
        try? Data(header).write(to: outputURL)
    }

    private var excludedBundleIds: Set<String> {
        [
            "com.meetingrecorder.system-audio-recorder",
            "com.meetingrecorder.app",
            "com.github.Electron",
            "Electron"
        ]
    }

    private var preferredAudioSourceBundleIds: Set<String> {
        [
            "com.google.Chrome",
            "com.google.Chrome.canary",
            "org.chromium.Chromium",
            "com.microsoft.edgemac",
            "com.brave.Browser",
            "company.thebrowser.Browser",
            "com.apple.Safari",
            "org.mozilla.firefox"
        ]
    }

    private func selectDisplay(from content: SCShareableContent) -> SCDisplay? {
        guard !content.displays.isEmpty else {
            return nil
        }

        if content.displays.count == 1 {
            return content.displays[0]
        }

        let normalWindows = content.windows.filter { window in
            guard let application = window.owningApplication else {
                return false
            }

            return window.isOnScreen &&
                window.windowLayer == 0 &&
                window.frame.width > 0 &&
                window.frame.height > 0 &&
                !excludedBundleIds.contains(application.bundleIdentifier)
        }
        let preferredWindows = normalWindows.filter { window in
            guard let application = window.owningApplication else {
                return false
            }

            return preferredAudioSourceBundleIds.contains(application.bundleIdentifier)
        }
        let activeWindows: [SCWindow]

        if #available(macOS 13.1, *) {
            activeWindows = normalWindows.filter { $0.isActive }
        } else {
            activeWindows = []
        }

        let candidateWindows = !preferredWindows.isEmpty
            ? preferredWindows
            : (!activeWindows.isEmpty ? activeWindows : normalWindows)

        return bestDisplay(for: candidateWindows, displays: content.displays) ?? content.displays[0]
    }

    private func bestDisplay(for windows: [SCWindow], displays: [SCDisplay]) -> SCDisplay? {
        var bestDisplay: SCDisplay?
        var bestArea: CGFloat = 0

        for display in displays {
            let displayFrame = display.frame
            let area = windows.reduce(CGFloat(0)) { total, window in
                total + displayFrame.intersection(window.frame).area
            }

            if area > bestArea {
                bestArea = area
                bestDisplay = display
            }
        }

        return bestDisplay
    }
}

func emit(_ message: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: message) {
        var lineData = data
        lineData.append(contentsOf: [0x0A])
        FileHandle.standardOutput.write(lineData)
    }
}

func parseOutputPath() throws -> String {
    let arguments = CommandLine.arguments
    guard let outputIndex = arguments.firstIndex(of: "--output"),
          outputIndex + 1 < arguments.count else {
        throw RecorderError.missingOutputPath
    }

    return arguments[outputIndex + 1]
}

@main
struct Main {
    static func main() async {
        guard #available(macOS 13.0, *) else {
            emit(["type": "error", "message": "macOS 13 이상에서만 시스템 오디오 녹음을 사용할 수 있습니다."])
            exit(1)
        }

        do {
            let outputPath = try parseOutputPath()
            let recorder: any SystemAudioRecording

            if #available(macOS 14.2, *) {
                recorder = ProcessTapSystemAudioRecorder(outputPath: outputPath)
            } else {
                recorder = ScreenCaptureKitSystemAudioRecorder(outputPath: outputPath)
            }

            try await recorder.start()
            emit(["type": "ready"])

            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
                    break
                }
            }

            await recorder.stop()
            emit(["type": "done"])
            exit(0)
        } catch {
            emit(["type": "error", "message": "\(error)"])
            exit(1)
        }
    }

}

private extension CGRect {
    var area: CGFloat {
        guard !isNull, !isEmpty else {
            return 0
        }

        return width * height
    }
}
