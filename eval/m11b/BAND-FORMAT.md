# GarageBand project format: audio tracks and region slots (M11b)

What `gb_band` relies on to put stems on any audio track of a project — no donor with one slot per region. Checked on
GarageBand 10.4.14 saves: `test/fixtures/band/donor-av.band` (2 audio + 2 instrument tracks) and
`test/fixtures/band/midi-plus-empty-audio.band` (a MIDI import with one empty audio track added through
Track ▸ New Tracks…). Code: `src/band/tracks.ts`, `src/band/graft.ts`. Apple does not document this format; a
GarageBand update can change it.

## Records (context)

- `Alternatives/000/ProjectData` holds records: a reversed FourCC tag, a 36-byte header (u32 group at +8) and a payload.
- `AuFl` (audio file) and `AuRg` (audio region) of region n are in group n × 0x40000; the region's `GenM` is in group
  (n + 1) × 0x40000.
- Placements are 80-byte events in the arrangement `EvSq` (group 0x40000). Audio events start with 0x24, MIDI events
  with 0x20. Position u64 at +4 = 34560 + tick (960 ticks per beat). Track byte at +0x14 = the track number GarageBand
  shows. Link at +0x2C = region × 4.

## Tracks and channel strips

- **Visible tracks.** The `Trak` records of group 0x40000 whose first u32 has low half 0x0001, in record order, are the
  tracks GarageBand shows (track 1, 2, …). High half 0x0014 = the track holds regions (GarageBand sets it on save);
  0x00000001 = an empty track; 3 = a record that is not a visible track. The u32 at +8 is the track's channel strip.
- **Channel strips.** The strip's `Envi` record is in group strip << 16. Bit 0x80 of byte 0x60 is set for an
  instrument strip and clear for an audio strip. The strip name is `[u8 length @0x9E][ASCII @0xA0]`.
- **Placement +0x10 is the channel strip.** An audio placement carries the strip of its track; a placement with the
  wrong strip plays through the wrong channel. `gb_band` writes the target track's strip.

## A new audio-region slot

What GarageBand writes when a region is added, and what `graftAudioSlots` writes:

- `AuFl` + `AuRg` in group n × 0x40000, `GenM` in group (n + 1) × 0x40000 with u32 @+0x0C = n × 4.
- The audio files form a chain: relative to each `AuFl`'s "EVAW", +0x38 = n + 1 and +0x3E = the next region × 4
  (0xFFFFFFFF for the last).
- Each region has its own 16-byte identity in `AuRg`: 4 bytes @+0x2A, 4 @name_end+0x56, 8 @name_end+0x5E.
- The track's `Trak` gets the "holds regions" flag.
- The slot template is region 0 of `donor-av.band` (`src/band/audio-slot-template.ts`; a test keeps them equal).

## Proof

A slot grafted onto the empty Audio 1 of a MIDI import opened with no dialog; GarageBand's re-save kept the region; the
export played the sample at bar 1 (correlation 0.96 with the source) together with the MIDI piano. The full chain over
MCP is `eval/m11b` (stem lag 0.0 ms, MIDI parts intact). Making a new audio track stays a GarageBand operation
(`gb_tracks add_audio`): a track adds about 50 records across 7 tags.
