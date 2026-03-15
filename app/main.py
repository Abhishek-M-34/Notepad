import os
import json
import io
import nltk
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from textblob import TextBlob
from spellchecker import SpellChecker
from groq import Groq
from dotenv import load_dotenv
from typing import List

try:
    nltk.download('punkt', quiet=True)
    nltk.download('wordnet', quiet=True)
    nltk.download('punkt_tab', quiet=True)
except:
    pass

load_dotenv()

app = FastAPI(title="AI Notepad")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")
templates = Jinja2Templates(directory="app/templates")

spell = SpellChecker()
client = Groq(api_key=os.environ.get("GROQ_API_KEY"))


class EditorContent(BaseModel):
    text: str
    last_word: str = ""


class WordBatch(BaseModel):
    words: List[str]


class SentenceCheck(BaseModel):
    sentence: str


@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/analyze")
async def analyze_text(content: EditorContent):
    text = content.text
    if not text.strip() or len(text.strip()) < 5:
        return {"theme": "Neutral", "format": "Keep writing...", "next_word": "", "grammar_fixes": ""}

    try:
        prompt = f"""Analyze the following text and return ONLY a JSON object.
1. 'theme': Identify the writing type from: Email, Letter, Novel, Song, Blog, Code, Journal, Report, Essay, Story, Other.
2. 'format': Provide one concise formatting tip (max 80 chars).

Text: {text[-500:]}"""

        chat_completion = client.chat.completions.create(
            messages=[
                {"role": "system", "content": "You are a writing assistant. Output ONLY valid JSON."},
                {"role": "user", "content": prompt}
            ],
            model="llama-3.1-8b-instant",
            response_format={"type": "json_object"}
        )

        result = json.loads(chat_completion.choices[0].message.content)
        result["grammar_fixes"] = ""
        result["next_word"] = ""
        return result
    except Exception as e:
        print(f"Analyze error: {e}")
        return {"theme": "Detecting...", "format": "Start typing to see tips.", "grammar_fixes": "", "next_word": ""}


@app.post("/api/spell_check_batch")
async def spell_check_batch(batch: WordBatch):
    """Check a batch of words for spelling errors and return suggestions."""
    valid_words = [w for w in batch.words if len(w) >= 3 and w.replace("'", "").isalpha()]
    if not valid_words:
        return {"misspelled": {}}

    misspelled = spell.unknown(valid_words)
    result = {}
    for word in misspelled:
        word_lower = word.lower()
        candidates = list(spell.candidates(word_lower) or [])
        candidates = [c for c in candidates if c.lower() != word_lower]
        result[word_lower] = candidates[:5]
    return {"misspelled": result}


@app.post("/api/check_sentence_grammar")
async def check_sentence_grammar(content: SentenceCheck):
    """Check a single sentence for grammatical errors using Groq."""
    sentence = content.sentence.strip()

    if not sentence or len(sentence.split()) < 3:
        return {"has_error": False, "corrected": sentence}

    try:
        prompt = f"""Check this sentence for grammatical errors. Be strict but only flag real, clear grammar errors.

Sentence: "{sentence}"

Return ONLY a JSON object with exactly these two fields:
{{
  "has_error": true or false,
  "corrected": "the corrected sentence here (same as input if no errors)"
}}

Rules:
- Only flag clear errors: wrong verb tense, subject-verb disagreement, wrong article (a/an/the), dangling modifiers
- Do NOT change: proper nouns, technical terms, abbreviations, stylistic choices, informal language
- Do NOT add commas for style — only correct real grammar mistakes
- If corrected equals the original (case-insensitive), set has_error to false"""

        chat_completion = client.chat.completions.create(
            messages=[
                {"role": "system", "content": "You are a precise grammar checker. Output ONLY valid JSON."},
                {"role": "user", "content": prompt}
            ],
            model="llama-3.1-8b-instant",
            response_format={"type": "json_object"}
        )

        result = json.loads(chat_completion.choices[0].message.content)
        has_error = bool(result.get("has_error", False))
        corrected = result.get("corrected", sentence)

        if not corrected or corrected.strip().lower() == sentence.strip().lower():
            has_error = False
            corrected = sentence

        return {"has_error": has_error, "corrected": corrected}
    except Exception as e:
        print(f"Grammar check error: {e}")
        return {"has_error": False, "corrected": sentence}


@app.post("/api/grammar_correct")
async def grammar_correct(content: EditorContent):
    """Correct the entire text for grammar and spelling."""
    text = content.text
    if not text.strip():
        return {"corrected": text}
    try:
        prompt = f"""Correct the following text for grammar and spelling errors only. 
Preserve the original style, tone, formatting, and structure.
Return ONLY the corrected text with no preamble or explanation.

Text:
{text}"""
        chat_completion = client.chat.completions.create(
            messages=[
                {"role": "system", "content": "You are a professional editor. Return only the corrected text."},
                {"role": "user", "content": prompt}
            ],
            model="llama-3.1-8b-instant",
        )
        return {"corrected": chat_completion.choices[0].message.content.strip()}
    except Exception as e:
        return {"corrected": text}


@app.post("/api/download")
async def download_note(content: EditorContent):
    buffer = io.BytesIO(content.text.encode('utf-8'))
    return StreamingResponse(
        buffer,
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=note.txt"}
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5000)