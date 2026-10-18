# NyxMix vs. Adobe Audition — feature by feature

NyxMix is a free, open-source (MIT) alternative to Adobe Audition. This page checks it
against every feature in Audition's official reference.

Source for Audition's feature set: the official *Adobe Audition CC Reference*
(help.adobe.com/archive/en/audition/cc/2013/audition_reference.pdf), chapter
"Effects reference" and the editing, multitrack, video/surround, export and shortcut
chapters, plus features Adobe added later (Essential Sound with auto-ducking, Remix,
DeReverb/DeNoise, Match Loudness, Loudness Radar) and the release notes up to
Audition 26.3 (June 2026): light mode and "Zoom to time" (25.2), Windows-on-ARM builds
(26.0/26.3), and the **removal of CD authoring** in 26.3 (CD Layout panel, CD track markers).
Evidence column: the automated test in `test/` that proves NyxMix's equivalent works
(`npm test` runs all of them).

Legend: **=** equivalent · **+** NyxMix does more · **≈** partial · **–** missing

## Amplitude and compression
| Audition | NyxMix | | Evidence |
|---|---|---|---|
| Amplify | `gain` effect, clip gain | = | effects render through the shared graph |
| Channel Mixer | `channelmixer` effect | = | looping clips …; studio effects |
| DeEsser | `deesser` effect + `deess` process | = | (worklet DSP; shared graph) |
| Dynamics Processing | `compressor`, `expander`, `gate`, `transient` | = | expander / transient tests |
| Hard Limiter | `limiter` (true-peak aware, lookahead) | + | limiter holds true peak (inter-sample) under the ceiling |
| Multiband Compressor | `multiband` (LR4 crossovers) | = | multiband: bands sum flat … |
| Normalize | `normalize` process | = | process … swaps the asset in clips |
| Single-band Compressor | `compressor` | = | effects render through the shared graph |
| Speech Volume Leveler | `level` process | = | (process) |
| Tube-modeled Compressor | live preset `tube-compressor`; LV2 Calf Tape Simulator / Saturator | = | every built-in preset applies and renders cleanly |
| Match Loudness / Volume | loudness process, clip "Match loudness", export normalisation | + | render matches loudness target … |
| Fade / Gain Envelope | clip fades (4 curve shapes) + clip volume envelopes | = | clip volume envelope follows the audio when the clip moves |

## Delay and echo
| Analog Delay | live preset `analog-delay` (damped ping-pong + saturation); LV2 Calf Vintage Delay | = | every built-in preset …; pingpong test |
| Delay, Echo | `delay`, `pingpong` | = | pingpong test |

## Diagnostics
| DeClipper | `declip` process | = | … declip, correlation |
| DeClicker / Click-Pop Eliminator / Automatic Click Remover | `declick` process, spectral spot heal | + | brush heal removes a click |
| Delete Silence | `removeSilence` process, "Shorten pauses" (non-destructive) | + | analysis finds the gap; transcript cuts |
| Mark Audio | silence/speech detection → range markers | = | auto-duck speech regions |

## Filter and EQ
| FFT Filter, Scientific Filter | `filter` (7 modes), `eq`, LV2 filters | = | filter slopes test |
| Graphic Equalizer (10/20/30 band) | `graphiceq` (10), `graphiceq30` (1/3 octave) | = | studio effects test |
| Notch Filter | `filter` notch, `dehum` | = | filter … notch depth |
| Parametric Equalizer | `eq` with draggable curve | = | effect parameter automation … |

## Modulation
| Chorus, Flanger, Chorus/Flanger, Phaser | `chorus`, `flanger`, `phaser`, `doubler` (timeline-locked LFOs) | + | modulation effects render with timeline-locked phase |

## Noise reduction / restoration
| Noise Reduction (noise print) | `noise_reduction` (own STFT Wiener) | + | reduceNoise beats ffmpeg afftdn |
| Adaptive Noise Reduction, Hiss Reduction | `denoise`, `voiceDenoise` (neural RNNoise) | + | neural voice denoise runs |
| DeHummer | `dehum` | = | |
| Sound Remover | `soundRemove` (learns a sound from an example span) | = | processes test: second ring −36 dB, rest −0.00 dB |
| DeReverb (2018+) | `dereverb` (late-reverb suppression, automatic RT60) | = | processes test: tail −18.1 dB, direct −0.00 dB, RT60 estimate 1.006 s |

## Reverb
| Convolution Reverb | `convolution` with any IR from the bin | = | studio effects test (IR tail) |
| Full / Studio / Reverb / Surround Reverb | `reverb`, convolution on 5.1 buses, LV2 reverbs, Faust `re.zita_rev1` | = | Faust test |

## Special
| Distortion, Guitar Suite | `distortion`, `bitcrusher`, `saturation`, live preset `guitar-amp`; LV2 MDA Combo (amp + cabinet), MDA Overdrive | = | distortion test; every built-in preset … |
| Doppler Shifter | `doppler` (fractional delay + distance gain) | = | processes test: 1089 Hz → 926 Hz (theory 1096/920) |
| Mastering | master presets + limiter + `check_delivery` | + | delivery check tests |
| Vocal Enhancer | `vocalenhancer` | = | vocalenhancer test |

## Stereo imagery
| Center Channel Extractor | `centerExtract` (STFT similarity mask, extract or remove) | = | processes test: centre kept −0.00 dB, side −134 dB |
| Graphic Phase Shifter | `phaseshift` effect | = | studio effects test |
| Stereo Expander | `width` effect | = | stereo width test |
| Automatic Phase Correction | `phaseAlign` (sub-sample cross-correlation) | = | processes test: found 0.500 ms, correlation 0.29 → 1.00 |
| Phase / frequency / amplitude analysis | goniometer, correlation, live spectrum, analysis API | = | correlation test |

## Time and pitch
| Automatic Pitch Correction | `pitchCorrect` (WORLD) | = | (process) |
| Manual Pitch Correction | spectral Pitch tool + `pitch_curve` | = | pitch curve shifts a voiced span … |
| Pitch Bender | `pitchBend` (band-limited varispeed) | = | processes test: length 0.7213× as expected, pitch doubles |
| Pitch Shifter | `pitchshift` effect, `pitch` process (Rubber Band) | = | pitchshift test |
| Stretch and Pitch, clip stretching | `tempo`, `stretch_clip` | = | stretch a clip to an exact length |
| Remix | `remix_music` (beat-matched, editable clips) | + | remix fits a music clip … |

## Generate
| Tones, Noise, (Speech) | `generate_audio`: tones, noise, silence, speech (local TTS) | + | generate test |

## Editing, multitrack, session
| Waveform/spectral editing: marquee, lasso, brush, spot heal, pitch display | all five tools | = | spectral tests |
| Copy/cut/paste, markers, range markers, selection | yes | = | |
| Undo/redo, History panel | undo/redo, jumpable history, named versions | + | proposals: … versions restore |
| Multitrack: move/trim/split/ripple, crossfades, snapping | yes (+ automatic equal-power crossfades) | = | ripple delete …; auto crossfade … |
| Looping clips | `loop` on clips | = | looping clips repeat their source |
| Envelopes / automation (volume, pan, effect parameters) | yes | = | effect parameter automation …; volume automation … |
| Buses, sends, routing | yes (pre/post, solo-safe buses) | = | buses … |
| Mixer, meters, loudness radar | mixer, peak/RMS, EBU R128 live meter | = | (LUFS meter verified against ffmpeg ebur128) |
| Essential Sound, auto-ducking | presets + `auto_duck` | = | auto-duck writes automation around speech |
| Favorites, batch processing | user presets, `batch_process` | = | user presets test |
| Recording, punch-in, latency compensation | yes (measured round trip) | = | (browser test with fake mic) |
| 5.1 surround | yes | = | 5.1 surround test |
| Video | synced video, filmstrip, frames, scene detection | + | video tests |
| Convert sample type | `convert_sample_rate` (SoX) | = | convert session sample rate keeps timing and pitch |
| Export formats, XMP metadata | WAV/FLAC/MP3/AAC/Opus, tags, chapters, stems, range-marker files | + | export tests |
| Keyboard shortcut customisation | yes | = | (browser test) |
| Third-party plug-ins (VST/AU) | Native **VST3** hosting (110 tested Linux VST3 effects: LSP, ZAM, Dragonfly, DISTRHO, MDA) plus LV2 (165: LSP, Calf, x42, MDA) in one catalog with search, A/B preview, range apply and measured latency compensation; plus Faust and AudioWorklet plugins live on tracks | ≈ | VST3 tests (LSP filter, ZamComp dual-mono, look-ahead limiter compensated), LV2 tests, Faust and plugin tests |
| CD layout (removed from Audition in 26.3) | `export_cd`: 44.1/16-bit TPDF-dithered WAV + CUE sheet, tracks from markers (burn with any burner; browsers cannot drive an optical drive) | + | CD image test; conformance: dither noise floor |
| Light mode, Zoom to time (25.2) | light/dark/auto theme, zoom presets | = | (browser test) |

## Only in NyxMix
Open REST/MCP API for agents (~80 tools), live shared sessions with authorship, proposals
(preview → accept/reject), transcript-based editing and language-aware filler removal,
delivery checks (podcast/EBU/ATSC/streaming/ACX), runs in a browser with nothing installed,
crash-isolated parallel rendering.

## Platform limits (cannot be built in a browser)
- **Native plugins run on the server, not in the browser.** NyxMix hosts VST3 and LV2 natively
  on the server (applied as processes with preview); only Faust and AudioWorklet plugins run
  live on tracks. Plugins built only for Windows or macOS (and AU, which is macOS-only) cannot
  load on a Linux server — just as Audition cannot load Linux builds.
- **Software monitoring latency.** Browsers cannot reach ASIO buffer sizes. NyxMix
  measures the round trip so takes land sample-exact; for zero-latency monitoring use the
  audio interface's direct monitoring (as most Audition users do too).

## Measured output quality
`docs/conformance.md` (generated by `node test/conformance-report.mjs`, asserted by
`test/conformance.test.mjs`) runs 48 checks against published standards with independent
measurement. All pass:
- Loudness: EBU Tech 3341 cases 1–6, 9, 12 and Tech 3342 LRA cases 1–4, within ±0.1 LU,
  for both the server analysis and the live meter.
- True peak (BS.1770-4 Annex 2): the meter and the limiter stay under a −1 dBTP ceiling on
  Gibbs-overshoot squares, +6 dB-hot noise and 17 kHz multitones (8× oversampled,
  32-tap Kaiser-sinc detection).
- Transparency: unprocessed clips null against the source with no residual at all at
  44.1/48/96 kHz, mono and stereo, also through buses, after trims, at one-sample offsets,
  and between parallel and single-pass renders.
- Sample-rate conversion, 24-bit rounding, 16-bit TPDF dither and the 0 dB dual-mono pan law
  match their reference values.

Cases defined only by EBU reference audio files (3341 cases 7, 8, 10, 11, 13, 14, 20–23;
3342 cases 5, 6) are not reproduced.
