# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""Builds loops-fixture.db: the real LoopsDatabaseV10 table definitions (subset) with edge-case rows."""
import sqlite3, os
from urllib.parse import quote
here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "loops-fixture.db")
if os.path.exists(path): os.remove(path)
con = sqlite3.connect(path)
con.executescript("""
CREATE TABLE Loops (id INTEGER PRIMARY KEY AUTOINCREMENT, fileURL TEXT, fileName TEXT, key INTEGER, numberOfBeats INTEGER,
  timeSignatureTop INTEGER, timeSignatureBottom INTEGER, tempo INTEGER, keyType INTEGER, fileType INTEGER, hasMidi INTEGER,
  theme TEXT, collection TEXT, comment TEXT, copyright TEXT, author TEXT, title TEXT, isWebLoop INTEGER, lengthInSeconds FLOAT,
  instrumentTypeId INTEGER, instrumentSubTypeId INTEGER, genreId INTEGER, singleEnsembleKeywordId INTEGER, partFillKeywordId INTEGER,
  acousticElectricKeywordId INTEGER, dryProcessedKeywordId INTEGER, cleanDistortedKeywordId INTEGER, cheerfulDarkKeywordId INTEGER,
  relaxedIntenseKeywordId INTEGER, groovingArrhythmicKeywordId INTEGER, melodicDissonantKeywordId INTEGER,
  contentIdentifier TEXT, chineseTranscript TEXT, originalFilename TEXT, patchInfo INTEGER, gbLoopType INTEGER, hasChords INTEGER);
CREATE TABLE LoopsKeywords (loopId INTEGER PRIMARY KEY, instrumentType TEXT, instrumentSubType TEXT, genre TEXT, descriptors TEXT);
CREATE TABLE JamPacks (identifier TEXT PRIMARY KEY, jamPackName TEXT, manufacturer TEXT, isVirtualJamPack INTEGER);
CREATE TABLE JamPackLoopRelation (jamPackId TEXT, loopId INTEGER, UNIQUE (jamPackId, loopId) ON CONFLICT REPLACE);
""")
A = "file:///Library/Audio/Apple%20Loops/Apple/"
loops = [
  # id, fileName, key, keyType, tempo, beats, length, hasMidi, (type, subtype, genre, descriptors), pack(s)
  (-9223043008183248613, "Uptown Perimeter Melody.caf", 55, 1, 152, 32, 12.63, 0, ("Keyboards", "Synthesizer", "Hip Hop", "Dark"), ["Take A Daytrip"]),
  (101, "Phantom Pulse Bass.caf", 53, 2, 140, 8, 3.43, 0, ("Bass", "Synthetic Bass", "Dubstep", "Melodic,Intense,Electric,Dark"), ["03 Dubstep"]),
  (102, "Trance Gate Synth.caf", 57, 2, 128, 16, 7.5, 1, ("Keyboards", "Synthesizer", "Electronic/Dance", "Grooving,Electric,Processed"), ["Dancefloor Rush", "Electronic Pop"]),
  (103, "Four On The Floor Beat.caf", 0, 0, -1, 16, 7.5, 2, ("Drums", "Drum Kit", "Electronic/Dance", "Grooving,Part"), ["Dancefloor Rush"]),
  (104, "Dark's 'Edge' % Bass.caf", 53, 2, 128, 8, 3.75, 0, ("Bass", "Synthetic Bass", "Electronic/Dance", "Darkest,Intense"), ["03 Dubstep"]),
]
packs = {p for *_, ps in loops for p in ps}
for p in packs:
    con.execute("insert into JamPacks values (?,?,?,0)", (f"com.apple.music.apps.LocalDomain.Apple{p}", p, "Apple Inc."))
for (i, name, key, ktype, tempo, beats, length, midi, (it, ist, genre, desc), ps) in loops:
    con.execute("""insert into Loops (id, fileURL, fileName, key, numberOfBeats, timeSignatureTop, timeSignatureBottom, tempo, keyType,
                   fileType, hasMidi, isWebLoop, lengthInSeconds, originalFilename) values (?,?,?,?,?,4,4,?,?,1,?,0,?,?)""",
                (i, A + quote(name), name, key, beats, tempo, ktype, midi, length, name))
    con.execute("insert into LoopsKeywords values (?,?,?,?,?)", (i, it, ist, genre, desc))
    for p in ps:
        con.execute("insert into JamPackLoopRelation values (?,?)", (f"com.apple.music.apps.LocalDomain.Apple{p}", i))
con.commit(); con.close()
print("wrote", path)
