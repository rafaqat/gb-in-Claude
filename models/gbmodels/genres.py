# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""The genres gb-mcp knows. CLAP ranks a recording against these labels. M8_GENRES are the M8 evaluation set's 20
(frozen: their order and words stay); M14 added 27 (Latin, Arabic, Maghreb, Levantine, country, Bollywood, gospel …)."""
M8_GENRES = [
    "lo-fi hip-hop", "R&B", "ambient", "jazz ballad", "reggaeton", "synthwave", "pop", "afrobeats", "funk", "indie rock",
    "deep house", "techno", "UK garage", "trap", "drum and bass", "EDM (big room)", "classical/pop crossover",
    "ambient trance (William Orbit style)", "Levantine ethereal strings (Fairuz style)", "epic orchestral (Hans Zimmer style)",
]
M14_GENRES = [
    "Latin trap", "dembow", "bachata", "salsa", "cumbia", "bossa nova", "corridos tumbados", "Latin pop",
    "Brazilian funk", "merengue",
    "Arabic pop", "Khaleeji", "mahraganat", "raï", "gnawa", "Moroccan chaabi", "dabke",
    "country", "Americana", "Bollywood (filmi)", "gospel", "soul", "blues", "Celtic folk", "lullaby", "K-pop", "amapiano",
]
GENRES = M8_GENRES + M14_GENRES

# M14: the text CLAP compares a recording with. The M8 twenty keep "<genre> music" (their scores stay comparable); a new
# genre gets a wording where that ranked its own clips higher (eval/m14/calibration: two 30 s ACE-Step clips per genre;
# the greedy choice on seed 1 held on seed 2 — MRR 0.20 → 0.32, own label in the top 5: 7 → 12 of 27 — so the final
# choice used both seeds).
CLAP_PROMPTS: dict[str, str] = {
    "Latin trap": "Latin trap music with 808 bass and Spanish rap",
    "bachata": "Dominican bachata guitar music",
    "bossa nova": "Brazilian bossa nova jazz",
    "corridos tumbados": "Mexican regional music with tuba and guitars",
    "Brazilian funk": "baile funk music",
    "merengue": "merengue music with tambora, guira and accordion",
    "Arabic pop": "Egyptian Arabic pop music",
    "Khaleeji": "Khaleeji Arabian Gulf music with oud and hand claps",
    "mahraganat": "Egyptian mahraganat electro shaabi music",
    "Moroccan chaabi": "Moroccan chaabi music with violin and darbuka",
    "dabke": "Lebanese dabke folk dance music",
    "country": "modern country music with pedal steel guitar",
    "Americana": "Americana roots music with banjo",
    "Bollywood (filmi)": "Bollywood film music with sitar, tabla and strings",
    "soul": "Motown soul music",
    "blues": "twelve-bar blues",
    "Celtic folk": "Irish folk music",
    "lullaby": "gentle lullaby music box",
    "amapiano": "amapiano house music",
}


def clap_prompt(genre: str) -> str:
    return CLAP_PROMPTS.get(genre, f"{genre} music")
