// SPDX-License-Identifier: MIT
// Copyright (c) 2026 rafaqat
// gm-render: offline render of a timed MIDI event list through macOS's built-in DLS General MIDI synth.
// Usage: gm-render <new-output.wav>   (event list JSON on stdin)
// stdin:  {"duration_s": Double, "events": [{"t": seconds, "bytes": [status, data1(, data2)]}]}
// stdout: exactly one JSON line: {"ok":true,"path":…,"seconds":…,"peak":…} | {"ok":false,"error":{"code":…,"message":…}}
import AVFoundation
import Foundation

struct Event: Decodable { let t: Double; let bytes: [Int] }
struct Input: Decodable { let duration_s: Double; let events: [Event] }

let sampleRate = 44100.0
let blockFrames: AVAudioFrameCount = 64 // ≤ 1.5 ms event timing granularity
let tailSeconds = 2.0 // let releases and reverb ring out
let maxSeconds = 20.0 * 60.0

func emit(_ object: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(object["ok"] as? Bool == true ? 0 : 2)
}
func fail(_ code: String, _ message: String) -> Never { emit(["ok": false, "error": ["code": code, "message": message]]) }

guard CommandLine.arguments.count == 2 else { fail("INPUT_INVALID", "usage: gm-render <output.wav>") }
let outURL = URL(fileURLWithPath: CommandLine.arguments[1])
// Exclusive create: claim the path first, never overwrite.
let fd = open(outURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
if fd < 0 { fail(errno == EEXIST ? "FILE_EXISTS" : "WRITE_FAILED", errno == EEXIST ? "output exists; nothing written" : "cannot create output") }
close(fd)
func abandon(_ code: String, _ message: String) -> Never { try? FileManager.default.removeItem(at: outURL); fail(code, message) }

let input: Input
do { input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile()) }
catch { abandon("INPUT_INVALID", "stdin is not a valid event list") }
guard input.duration_s >= 0, input.duration_s <= maxSeconds else { abandon("INPUT_INVALID", "duration out of range") }
let events = input.events.sorted { $0.t < $1.t }
for e in events where e.bytes.isEmpty || e.bytes.count > 3 || e.bytes.contains(where: { $0 < 0 || $0 > 255 }) || e.t < 0 {
  abandon("INPUT_INVALID", "bad MIDI event")
}

let engine = AVAudioEngine()
let dls = AudioComponentDescription(componentType: kAudioUnitType_MusicDevice, componentSubType: kAudioUnitSubType_DLSSynth,
                                    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
let synth = AVAudioUnitMIDIInstrument(audioComponentDescription: dls)
engine.attach(synth)
let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2)!
engine.connect(synth, to: engine.mainMixerNode, format: format)
do {
  try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: blockFrames)
  try engine.start()
} catch { abandon("RENDER_FAILED", "audio engine: \(error.localizedDescription)") }

let fileSettings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: 2,
                                   AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
let totalFrames = AVAudioFramePosition((input.duration_s + tailSeconds) * sampleRate)

/// Renders everything into a file that is scoped to this function, then closed: the WAV header
/// (RIFF/data sizes) is only finalized when AVAudioFile closes — `exit()` alone would skip that.
func renderToFile() -> Float {
  let file: AVAudioFile
  do { file = try AVAudioFile(forWriting: outURL, settings: fileSettings, commonFormat: .pcmFormatFloat32, interleaved: false) }
  catch { abandon("WRITE_FAILED", "cannot open output for writing") }
  let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: blockFrames)!
  var next = 0
  var peak: Float = 0
  while engine.manualRenderingSampleTime < totalFrames {
    let blockEnd = Double(engine.manualRenderingSampleTime + AVAudioFramePosition(blockFrames)) / sampleRate
    while next < events.count && events[next].t < blockEnd {
      let b = events[next].bytes.map { UInt8($0) }
      if b.count == 3 { synth.sendMIDIEvent(b[0], data1: b[1], data2: b[2]) } else if b.count == 2 { synth.sendMIDIEvent(b[0], data1: b[1]) }
      next += 1
    }
    let frames = AVAudioFrameCount(min(AVAudioFramePosition(blockFrames), totalFrames - engine.manualRenderingSampleTime))
    do {
      guard try engine.renderOffline(frames, to: buffer) == .success else { abandon("RENDER_FAILED", "render did not succeed") }
      for ch in 0..<Int(buffer.format.channelCount) {
        let samples = buffer.floatChannelData![ch]
        for i in 0..<Int(buffer.frameLength) { peak = max(peak, abs(samples[i])) }
      }
      try file.write(from: buffer)
    } catch { abandon("RENDER_FAILED", "render: \(error.localizedDescription)") }
  }
  if #available(macOS 15.0, *) { file.close() }
  return peak
}
let peak = renderToFile()
engine.stop()
emit(["ok": true, "path": outURL.path, "seconds": Double(totalFrames) / sampleRate, "peak": Double(peak)])
