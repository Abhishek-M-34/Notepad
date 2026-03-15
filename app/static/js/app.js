/* ════════════════════════════════════════════════════════
   NoteAI — app.js
   Features: Inline spell check, per-sentence grammar check,
   multi-note management, live search highlighting, status bar,
   focus mode, font size, line numbers, dark/light toggle.
════════════════════════════════════════════════════════ */

// ──────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────
const editor = document.getElementById('editor');
const backdrop = document.getElementById('highlight-backdrop');
const noteTitle = document.getElementById('note-title');
const notesList = document.getElementById('notes-list');

// ──────────────────────────────────────────
// State
// ──────────────────────────────────────────
let notes = [];
let activeNoteId = null;

let spellErrorRanges = [];   // [{start, end, word, suggestions}]
let grammarErrorRanges = [];  // [{sentence, corrected, sentenceKey}]
let searchMatches = [];  // [{start, end}]
let searchCurrentIndex = -1;

const ignoredSpellWords = new Set();
const ignoredGrammarKeys = new Set();
const userModifiedSentences = new Set();  // sentence texts user edited
const checkedSentences = new Map();  // sentence → {has_error, corrected}

let currentSpellError = null;
let currentGrammarError = null;

let fontSize = 15;
let focusMode = false;
let showLnNums = false;
let isDark = true;

let spellTimer = null;
let analysisTimer = null;
let grammarTimer = null;
let saveTimer = null;

const SPELL_DELAY = 900;
const ANALYSIS_DELAY = 2500;
const SAVE_INTERVAL = 2000;

// ──────────────────────────────────────────
// INIT
// ──────────────────────────────────────────
window.addEventListener('load', () => {
    loadNotes();
    if (!notes.length) createNote(false);
    else selectNote(notes[0].id);

    setInterval(autoSave, SAVE_INTERVAL);
    document.addEventListener('keydown', globalKeydown);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.popover') && !e.target.closest('#editor')) hidePopovers();
    });
});

// ──────────────────────────────────────────
// NOTE MANAGEMENT
// ──────────────────────────────────────────
function loadNotes() {
    try { notes = JSON.parse(localStorage.getItem('noteai_notes') || '[]'); }
    catch { notes = []; }
}

function persistNotes() {
    localStorage.setItem('noteai_notes', JSON.stringify(notes));
}

function createNote(andSelect = true) {
    const note = {
        id: `n${Date.now()}`,
        title: 'Untitled Note',
        content: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    notes.unshift(note);
    persistNotes();
    renderNotesList();
    if (andSelect) selectNote(note.id);
}

function createNewNote() { createNote(true); }

function selectNote(id) {
    // Flush current note
    if (activeNoteId) flushCurrentNote();

    activeNoteId = id;
    const note = notes.find(n => n.id === id);
    if (!note) return;

    editor.value = note.content;
    noteTitle.innerText = note.title;

    // Reset checks
    spellErrorRanges = [];
    grammarErrorRanges = [];
    searchMatches = [];
    searchCurrentIndex = -1;
    ignoredSpellWords.clear();
    ignoredGrammarKeys.clear();
    // Intentionally keep userModifiedSentences + checkedSentences for session cache

    updateHighlights();
    updateStatusBar();
    renderNotesList();
    scheduleSpellCheck();
    scheduleAnalysis();
    editor.focus();
}

function flushCurrentNote() {
    const note = notes.find(n => n.id === activeNoteId);
    if (note) {
        note.content = editor.value;
        note.title = noteTitle.innerText.trim() || 'Untitled Note';
        note.updatedAt = new Date().toISOString();
        persistNotes();
    }
}

function deleteNote(id, event) {
    event.stopPropagation();
    if (notes.length === 1) { showToast('Cannot delete the only note.'); return; }
    notes = notes.filter(n => n.id !== id);
    persistNotes();
    if (activeNoteId === id) selectNote(notes[0].id);
    else renderNotesList();
}

function renderNotesList() {
    notesList.innerHTML = '';
    notes.forEach(note => {
        const el = document.createElement('div');
        el.className = `note-item${note.id === activeNoteId ? ' active' : ''}`;
        el.onclick = () => selectNote(note.id);
        const preview = (note.content || '').slice(0, 55).replace(/\n/g, ' ').trim() || 'Empty note…';
        el.innerHTML = `
            <div class="note-item-top">
                <div class="note-item-title">${esc(note.title || 'Untitled')}</div>
                <button class="note-delete-btn" onclick="deleteNote('${note.id}', event)" title="Delete">×</button>
            </div>
            <div class="note-item-preview">${esc(preview)}</div>`;
        notesList.appendChild(el);
    });
}

function autoSave() {
    if (!activeNoteId) return;
    flushCurrentNote();
    setSaveStatus('saved');
}

function onTitleChange() {
    const note = notes.find(n => n.id === activeNoteId);
    if (note) {
        note.title = noteTitle.innerText.trim() || 'Untitled Note';
        renderNotesList();
        persistNotes();
    }
}

function onTitleKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
}

// ──────────────────────────────────────────
// EDITOR INPUT HANDLERS
// ──────────────────────────────────────────
function onEditorInput(e) {
    const pos = editor.selectionStart;
    const text = editor.value;

    // If user is typing inside a grammar error range → mark as user-modified
    for (let i = grammarErrorRanges.length - 1; i >= 0; i--) {
        const err = grammarErrorRanges[i];
        const curPos = text.indexOf(err.sentence);
        if (curPos >= 0 && pos > curPos && pos <= curPos + err.sentence.length + 2) {
            userModifiedSentences.add(err.sentence);
            grammarErrorRanges.splice(i, 1);
        }
    }

    updateHighlights();
    updateStatusBar();
    setSaveStatus('unsaved');
    scheduleSpellCheck();
    scheduleAnalysis();

    // Grammar: check on sentence-ending punctuation
    const lastChar = text[pos - 1];
    if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
        scheduleGrammarCheck(text, pos);
    }
}

function onEditorKeydown(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        const s = editor.selectionStart, en = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + '    ' + editor.value.slice(en);
        editor.selectionStart = editor.selectionEnd = s + 4;
        onEditorInput(e);
    }
    if (e.key === 'Escape') hidePopovers();
}

function onEditorClick(e) {
    updateCursorStat();
    const pos = editor.selectionStart;

    // Grammar errors take priority
    for (const err of grammarErrorRanges) {
        if (ignoredGrammarKeys.has(err.sentenceKey)) continue;
        const start = editor.value.indexOf(err.sentence);
        if (start >= 0 && pos >= start && pos <= start + err.sentence.length) {
            showGrammarPopover(err, e);
            return;
        }
    }

    // Spell errors
    for (const err of spellErrorRanges) {
        if (ignoredSpellWords.has(err.word.toLowerCase())) continue;
        if (pos >= err.start && pos <= err.end) {
            showSpellPopover(err, e);
            return;
        }
    }

    hidePopovers();
}

// ──────────────────────────────────────────
// SPELL CHECKING
// ──────────────────────────────────────────
function scheduleSpellCheck() {
    clearTimeout(spellTimer);
    spellTimer = setTimeout(runSpellCheck, SPELL_DELAY);
}

async function runSpellCheck() {
    const text = editor.value;
    if (!text.trim()) {
        spellErrorRanges = [];
        updateHighlights();
        updateStatusBar();
        return;
    }

    const wordRe = /\b[a-zA-Z']{3,}\b/g;
    const unique = new Set();
    let m;
    while ((m = wordRe.exec(text)) !== null) {
        const w = m[0].replace(/^'+|'+$/g, '');
        if (w.length >= 3) unique.add(w.toLowerCase());
    }
    if (!unique.size) return;

    try {
        const res = await fetch('/api/spell_check_batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ words: [...unique] })
        });
        const data = await res.json();
        const bad = data.misspelled || {};

        const currentText = editor.value;
        spellErrorRanges = [];
        const re2 = /\b[a-zA-Z']{3,}\b/g;
        let match;
        while ((match = re2.exec(currentText)) !== null) {
            const raw = match[0];
            const lead = (raw.match(/^'+/) || [''])[0].length;
            const trail = (raw.match(/'+$/) || [''])[0].length;
            const word = raw.slice(lead, raw.length - trail || undefined);
            const lower = word.toLowerCase();
            if (bad[lower] && !ignoredSpellWords.has(lower)) {
                spellErrorRanges.push({
                    start: match.index + lead,
                    end: match.index + raw.length - trail,
                    word,
                    suggestions: bad[lower]
                });
            }
        }
        updateHighlights();
        updateStatusBar();
        updateAiIssuesPanel();
    } catch (err) {
        console.warn('Spell check failed:', err);
    }
}

// ──────────────────────────────────────────
// GRAMMAR CHECKING
// ──────────────────────────────────────────
function scheduleGrammarCheck(text, cursorPos) {
    clearTimeout(grammarTimer);
    grammarTimer = setTimeout(() => checkGrammarAtCursor(text, cursorPos), 400);
}

function checkGrammarAtCursor(text, cursorPos) {
    const before = text.slice(0, cursorPos);

    // Extract the sentence that just ended
    const sentenceRe = /(?:^|(?<=[.!?]\s+))([^.!?]+[.!?])\s*$/;
    let sentence = '';

    // Walk backwards to find sentence boundary
    let end = cursorPos - 1;
    while (end > 0 && /\s/.test(text[end])) end--;
    let start = end;
    while (start > 0 && !/[.!?]/.test(text[start - 1])) start--;
    sentence = text.slice(start, end + 1).trim();

    if (!sentence || sentence.split(/\s+/).length < 3) return;
    if (userModifiedSentences.has(sentence)) return;
    if (checkedSentences.has(sentence)) {
        const cached = checkedSentences.get(sentence);
        if (cached.has_error) registerGrammarError(sentence, cached.corrected);
        return;
    }

    fetchGrammarCheck(sentence);
}

async function fetchGrammarCheck(sentence) {
    try {
        const res = await fetch('/api/check_sentence_grammar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentence })
        });
        const data = await res.json();
        checkedSentences.set(sentence, data);

        if (!data.has_error) return;
        if (userModifiedSentences.has(sentence)) return;

        // Verify sentence still exists in current text
        if (editor.value.indexOf(sentence) < 0) return;

        registerGrammarError(sentence, data.corrected);
    } catch (err) {
        console.warn('Grammar check error:', err);
    }
}

function registerGrammarError(sentence, corrected) {
    const key = sentence;
    if (ignoredGrammarKeys.has(key)) return;
    // Remove existing entry for same sentence
    grammarErrorRanges = grammarErrorRanges.filter(e => e.sentenceKey !== key);
    grammarErrorRanges.push({ sentence, corrected, sentenceKey: key });
    updateHighlights();
    updateStatusBar();
    updateAiIssuesPanel();
}

// ──────────────────────────────────────────
// HIGHLIGHT PIPELINE
// ──────────────────────────────────────────
function updateHighlights() {
    backdrop.innerHTML = buildBackdropHTML(editor.value);
    syncScroll();
    updateLineNumbers();
}

function buildBackdropHTML(text) {
    if (!text) return '';

    const ranges = [];

    // Spell errors (position-based)
    spellErrorRanges.forEach(e => {
        if (!ignoredSpellWords.has(e.word.toLowerCase()))
            ranges.push({ start: e.start, end: e.end, cls: 'spell-error' });
    });

    // Grammar errors (text-search based)
    grammarErrorRanges.forEach(e => {
        if (ignoredGrammarKeys.has(e.sentenceKey)) return;
        if (userModifiedSentences.has(e.sentence)) return;
        const pos = text.indexOf(e.sentence);
        if (pos >= 0)
            ranges.push({ start: pos, end: pos + e.sentence.length, cls: 'grammar-error' });
    });

    // Search matches
    searchMatches.forEach((m, i) => {
        ranges.push({
            start: m.start, end: m.end,
            cls: i === searchCurrentIndex ? 'search-highlight current' : 'search-highlight'
        });
    });

    // Sort & deduplicate (first-come wins on overlap)
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const deduped = [];
    let lastEnd = -1;
    for (const r of ranges) {
        if (r.start >= lastEnd) { deduped.push(r); lastEnd = r.end; }
    }

    // Build HTML string
    const e = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '';
    let pos = 0;
    for (const r of deduped) {
        if (r.start > pos) html += e(text.slice(pos, r.start));
        html += `<span class="${r.cls}">${e(text.slice(r.start, r.end))}</span>`;
        pos = r.end;
    }
    if (pos < text.length) html += e(text.slice(pos));

    // Convert newlines → <br> (needed since innerHTML treats \n as whitespace)
    return html.replace(/\n/g, '<br>');
}

function syncScroll() {
    backdrop.scrollTop = editor.scrollTop;
    backdrop.scrollLeft = editor.scrollLeft;
}

// ──────────────────────────────────────────
// LINE NUMBERS
// ──────────────────────────────────────────
function updateLineNumbers() {
    if (!showLnNums) return;
    const lnEl = document.getElementById('line-numbers');
    const lines = (editor.value || '').split('\n');
    lnEl.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    lnEl.scrollTop = editor.scrollTop;
}

function toggleLineNumbers() {
    showLnNums = !showLnNums;
    const lnEl = document.getElementById('line-numbers');
    lnEl.style.display = showLnNums ? 'flex' : 'none';
    document.getElementById('ln-btn').classList.toggle('active', showLnNums);
    if (showLnNums) updateLineNumbers();
}

// ──────────────────────────────────────────
// STATUS BAR
// ──────────────────────────────────────────
function updateStatusBar() {
    const text = editor.value || '';
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const chars = text.length;
    const lines = text.split('\n').length;
    const mins = Math.max(1, Math.round(words / 200));

    setText('stat-words', `${words} word${words !== 1 ? 's' : ''}`);
    setText('stat-chars', `${chars} char${chars !== 1 ? 's' : ''}`);
    setText('stat-lines', `${lines} line${lines !== 1 ? 's' : ''}`);
    setText('stat-read-time', `~${mins} min read`);

    updateCursorStat();
    updateErrorStats();
    updateAiIssuesPanel();
}

function updateCursorStat() {
    const text = editor.value || '';
    const pos = editor.selectionStart || 0;
    const before = text.slice(0, pos);
    const ln = before.split('\n').length;
    const col = pos - (before.lastIndexOf('\n') + 1) + 1;
    setText('stat-cursor', `Ln ${ln}, Col ${col}`);
}

function updateErrorStats() {
    const sc = spellErrorRanges.filter(e => !ignoredSpellWords.has(e.word.toLowerCase())).length;
    const gc = grammarErrorRanges.filter(e => !ignoredGrammarKeys.has(e.sentenceKey) && !userModifiedSentences.has(e.sentence) && editor.value.indexOf(e.sentence) >= 0).length;

    const spellEl = document.getElementById('stat-spell');
    const grammarEl = document.getElementById('stat-grammar');

    spellEl.textContent = `${sc} spelling`;
    grammarEl.textContent = `${gc} grammar`;
    spellEl.className = `stat-errors${sc > 0 ? ' has-spell-err' : ''}`;
    grammarEl.className = `stat-errors${gc > 0 ? ' has-grammar-err' : ''}`;
}

function updateAiIssuesPanel() {
    const sc = spellErrorRanges.filter(e => !ignoredSpellWords.has(e.word.toLowerCase())).length;
    const gc = grammarErrorRanges.filter(e => !ignoredGrammarKeys.has(e.sentenceKey) && !userModifiedSentences.has(e.sentence)).length;
    const sec = document.getElementById('ai-issues-section');
    const list = document.getElementById('ai-issues-list');

    if (sc === 0 && gc === 0) {
        sec.style.display = 'none';
        return;
    }
    sec.style.display = 'block';
    list.innerHTML = '';
    if (sc > 0) {
        const el = document.createElement('div');
        el.className = 'ai-issue-item spell';
        el.innerHTML = `<span>🔴</span> ${sc} misspelled word${sc !== 1 ? 's' : ''}`;
        list.appendChild(el);
    }
    if (gc > 0) {
        const el = document.createElement('div');
        el.className = 'ai-issue-item grammar';
        el.innerHTML = `<span>🟣</span> ${gc} grammar issue${gc !== 1 ? 's' : ''}`;
        list.appendChild(el);
    }
}

// ──────────────────────────────────────────
// AI ANALYSIS
// ──────────────────────────────────────────
function scheduleAnalysis() {
    clearTimeout(analysisTimer);
    analysisTimer = setTimeout(runAnalysis, ANALYSIS_DELAY);
}

async function runAnalysis() {
    const text = editor.value;
    if (!text.trim() || text.length < 10) return;
    setAiStatus('Analyzing…');
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (data.theme) {
            setText('theme-badge', data.theme);
            setText('ai-theme', data.theme);
        }
        if (data.format) setText('ai-format', data.format);
        // Auto-title if still default
        if (noteTitle.innerText === 'Untitled Note' && text.trim().length > 8) {
            const words = text.trim().split(/\s+/).slice(0, 4).join(' ');
            noteTitle.innerText = words.charAt(0).toUpperCase() + words.slice(1) + '…';
            onTitleChange();
        }
        setAiStatus('AI Ready');
    } catch {
        setAiStatus('Offline');
    }
}

function setAiStatus(s) {
    const el = document.getElementById('ai-status');
    el.textContent = s;
    el.className = `ai-status${s.includes('…') ? ' thinking' : s === 'Offline' ? ' error' : ''}`;
}

// ──────────────────────────────────────────
// POPOVERS
// ──────────────────────────────────────────
function showSpellPopover(err, event) {
    currentSpellError = err;
    hidePopovers();
    const pop = document.getElementById('spell-popover');
    const list = document.getElementById('spell-suggestions-list');
    setText('spell-word-label', err.word);
    list.innerHTML = '';

    if (!err.suggestions.length) {
        list.innerHTML = '<div class="popover-no-suggestions">No suggestions found</div>';
    } else {
        err.suggestions.forEach(sug => {
            const btn = document.createElement('button');
            btn.className = 'popover-suggestion';
            btn.textContent = sug;
            btn.onclick = () => applySpellFix(sug);
            list.appendChild(btn);
        });
    }
    placePopover(pop, event);
    pop.style.display = 'block';
}

function showGrammarPopover(err, event) {
    currentGrammarError = err;
    hidePopovers();
    const pop = document.getElementById('grammar-popover');
    setText('grammar-corrected-text', err.corrected);
    placePopover(pop, event);
    pop.style.display = 'block';
}

function placePopover(el, event) {
    el.style.display = 'block';   // measure
    const pw = el.offsetWidth || 260;
    const ph = el.offsetHeight || 160;
    let x = event.clientX;
    let y = event.clientY + 18;
    if (x + pw > window.innerWidth - 8) x = window.innerWidth - pw - 8;
    if (y + ph > window.innerHeight - 8) y = event.clientY - ph - 8;
    el.style.left = Math.max(8, x) + 'px';
    el.style.top = Math.max(8, y) + 'px';
}

function hidePopovers() {
    document.getElementById('spell-popover').style.display = 'none';
    document.getElementById('grammar-popover').style.display = 'none';
    currentSpellError = null;
    currentGrammarError = null;
}

// ──────────────────────────────────────────
// SPELL POPOVER ACTIONS
// ──────────────────────────────────────────
function applySpellFix(replacement) {
    if (!currentSpellError) return;
    const { start, end } = currentSpellError;
    const t = editor.value;
    editor.value = t.slice(0, start) + replacement + t.slice(end);
    editor.setSelectionRange(start + replacement.length, start + replacement.length);
    hidePopovers();
    scheduleSpellCheck();
    updateHighlights();
    updateStatusBar();
}

function ignoreSpellError() {
    if (!currentSpellError) return;
    ignoredSpellWords.add(currentSpellError.word.toLowerCase());
    spellErrorRanges = spellErrorRanges.filter(e => e.word.toLowerCase() !== currentSpellError.word.toLowerCase());
    hidePopovers();
    updateHighlights();
    updateStatusBar();
}

function addToDict() { ignoreSpellError(); }   // session-level "dictionary"

// ──────────────────────────────────────────
// GRAMMAR POPOVER ACTIONS
// ──────────────────────────────────────────
function applyGrammarFix() {
    if (!currentGrammarError) return;
    const err = currentGrammarError;
    const text = editor.value;
    const pos = text.indexOf(err.sentence);
    if (pos < 0) { hidePopovers(); return; }

    editor.value = text.slice(0, pos) + err.corrected + text.slice(pos + err.sentence.length);
    editor.setSelectionRange(pos + err.corrected.length, pos + err.corrected.length);

    grammarErrorRanges = grammarErrorRanges.filter(e => e.sentenceKey !== err.sentenceKey);
    hidePopovers();
    updateHighlights();
    updateStatusBar();
    scheduleSpellCheck();
}

function ignoreGrammarError() {
    if (!currentGrammarError) return;
    ignoredGrammarKeys.add(currentGrammarError.sentenceKey);
    grammarErrorRanges = grammarErrorRanges.filter(e => e.sentenceKey !== currentGrammarError.sentenceKey);
    hidePopovers();
    updateHighlights();
    updateStatusBar();
}

// ──────────────────────────────────────────
// SEARCH & REPLACE
// ──────────────────────────────────────────
let searchQuery = '';

function toggleFind() {
    const box = document.getElementById('find-box');
    const btn = document.getElementById('find-toggle-btn');
    const visible = box.style.display !== 'none';
    box.style.display = visible ? 'none' : 'flex';
    btn.classList.toggle('active', !visible);
    if (!visible) {
        document.getElementById('find-input').focus();
        // Pre-fill with selected text
        const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        if (sel) {
            document.getElementById('find-input').value = sel;
            searchQuery = sel;
            runSearch();
        }
    } else {
        clearSearch();
    }
}

function onFindInput() {
    searchQuery = document.getElementById('find-input').value;
    runSearch();
}

function onFindKeydown(e) {
    if (e.key === 'Enter') e.shiftKey ? findPrev() : findNext();
    if (e.key === 'Escape') toggleFind();
}

function onReplaceKeydown(e) {
    if (e.key === 'Enter') replaceOne();
}

function runSearch() {
    searchMatches = [];
    searchCurrentIndex = -1;
    if (!searchQuery) { updateHighlights(); updateMatchCount(); return; }

    const text = editor.value;
    const lower = text.toLowerCase();
    const qLow = searchQuery.toLowerCase();
    let pos = 0;
    while (pos < text.length) {
        const idx = lower.indexOf(qLow, pos);
        if (idx < 0) break;
        searchMatches.push({ start: idx, end: idx + searchQuery.length });
        pos = idx + 1;
    }
    if (searchMatches.length) searchCurrentIndex = 0;
    updateHighlights();
    updateMatchCount();
    scrollToCurrentMatch();
}

function findNext() {
    if (!searchMatches.length) { runSearch(); return; }
    searchCurrentIndex = (searchCurrentIndex + 1) % searchMatches.length;
    updateHighlights();
    updateMatchCount();
    scrollToCurrentMatch();
}

function findPrev() {
    if (!searchMatches.length) return;
    searchCurrentIndex = (searchCurrentIndex - 1 + searchMatches.length) % searchMatches.length;
    updateHighlights();
    updateMatchCount();
    scrollToCurrentMatch();
}

function scrollToCurrentMatch() {
    const m = searchMatches[searchCurrentIndex];
    if (!m) return;
    editor.focus();
    editor.setSelectionRange(m.start, m.end);
    // Scroll textarea to show selection
    const linesBefore = editor.value.slice(0, m.start).split('\n').length - 1;
    const lineH = parseFloat(getComputedStyle(editor).lineHeight);
    editor.scrollTop = Math.max(0, linesBefore * lineH - editor.clientHeight / 2);
    syncScroll();
}

function updateMatchCount() {
    const el = document.getElementById('match-count');
    if (!searchQuery) { el.textContent = ''; el.className = 'match-count'; return; }
    if (!searchMatches.length) { el.textContent = 'No matches'; el.className = 'match-count no-match'; return; }
    el.textContent = `${searchCurrentIndex + 1} / ${searchMatches.length}`;
    el.className = 'match-count';
}

function replaceOne() {
    const m = searchMatches[searchCurrentIndex];
    if (!m) return;
    const rep = document.getElementById('replace-input').value;
    const text = editor.value;
    editor.value = text.slice(0, m.start) + rep + text.slice(m.end);
    searchQuery = document.getElementById('find-input').value;
    runSearch();
    updateStatusBar();
}

function replaceAll() {
    if (!searchQuery) return;
    const rep = document.getElementById('replace-input').value;
    const re = new RegExp(regEsc(searchQuery), 'gi');
    editor.value = editor.value.replace(re, rep);
    clearSearch();
    scheduleSpellCheck();
    updateStatusBar();
}

function clearSearch() {
    searchQuery = '';
    searchMatches = [];
    searchCurrentIndex = -1;
    const fi = document.getElementById('find-input');
    const ri = document.getElementById('replace-input');
    if (fi) fi.value = '';
    if (ri) ri.value = '';
    updateMatchCount();
    updateHighlights();
}

function regEsc(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ──────────────────────────────────────────
// TOOLBAR ACTIONS
// ──────────────────────────────────────────
function undoAction() { editor.focus(); document.execCommand('undo'); }
function redoAction() { editor.focus(); document.execCommand('redo'); }

function changeFontSize(delta) {
    fontSize = Math.max(11, Math.min(22, fontSize + delta));
    editor.style.fontSize = backdrop.style.fontSize = fontSize + 'px';
    updateHighlights();
}

function toggleFocusMode() {
    focusMode = !focusMode;
    document.body.classList.toggle('focus-mode', focusMode);
    document.getElementById('focus-btn').classList.toggle('active', focusMode);
}

function toggleTheme() {
    isDark = !isDark;
    document.body.classList.toggle('light', !isDark);
    document.getElementById('theme-toggle-btn').classList.toggle('active', !isDark);
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('closed');
}

function toggleAiPanel() {
    document.getElementById('ai-panel').classList.toggle('collapsed');
}

// ──────────────────────────────────────────
// GRAMMAR FIX ALL
// ──────────────────────────────────────────
async function toggleGrammarFix() {
    const text = editor.value;
    if (!text.trim()) return;
    setAiStatus('Correcting…');
    try {
        const res = await fetch('/api/grammar_correct', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (data.corrected && data.corrected !== text) {
            editor.value = data.corrected;
            grammarErrorRanges = [];
            updateHighlights();
            scheduleSpellCheck();
            updateStatusBar();
            showToast('Grammar corrected ✓');
        } else {
            showToast('No grammar issues found!');
        }
        setAiStatus('AI Ready');
    } catch {
        setAiStatus('AI Ready');
        showToast('Fix failed — check connection.');
    }
}

// ──────────────────────────────────────────
// FILE OPERATIONS
// ──────────────────────────────────────────
function downloadNote() {
    const text = editor.value;
    const title = (noteTitle.innerText || 'note').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'note';
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `${title}.txt` });
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

function uploadNote(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        const note = {
            id: `n${Date.now()}`,
            title: file.name.replace(/\.[^.]+$/, ''),
            content: e.target.result,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        notes.unshift(note);
        persistNotes();
        selectNote(note.id);
    };
    reader.readAsText(file);
    event.target.value = '';
}

// ──────────────────────────────────────────
// SAVE STATUS
// ──────────────────────────────────────────
function setSaveStatus(status) {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    el.className = `save-dot ${status}`;
    el.title = status === 'saved' ? 'All changes saved' : 'Unsaved changes';
}

// ──────────────────────────────────────────
// GLOBAL KEYBOARD SHORTCUTS
// ──────────────────────────────────────────
function globalKeydown(e) {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'f') { e.preventDefault(); toggleFind(); }
        if (e.key === 's') { e.preventDefault(); autoSave(); setSaveStatus('saved'); }
        if (e.key === 'n') { e.preventDefault(); createNewNote(); }
    }
    if (e.key === 'Escape') hidePopovers();
}

// ──────────────────────────────────────────
// TOAST NOTIFICATIONS
// ──────────────────────────────────────────
let toastEl = null;
function showToast(msg) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement('div');
    toastEl.style.cssText = `
        position:fixed; bottom:48px; left:50%; transform:translateX(-50%);
        background:var(--bg-4); border:1px solid var(--border-hover);
        color:var(--text); padding:0.55rem 1.2rem; border-radius:20px;
        font-size:0.82rem; font-family:'Outfit',sans-serif; font-weight:500;
        z-index:10000; box-shadow:0 4px 16px rgba(0,0,0,0.3);
        animation: toastIn 0.2s ease;
    `;
    toastEl.textContent = msg;
    document.head.appendChild(Object.assign(document.createElement('style'), {
        textContent: `@keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(6px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }`
    }));
    document.body.appendChild(toastEl);
    setTimeout(() => toastEl && toastEl.remove(), 2800);
}

// ──────────────────────────────────────────
// UTILITY
// ──────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Keep line numbers scroll synced
editor.addEventListener('scroll', () => {
    syncScroll();
    if (showLnNums) {
        document.getElementById('line-numbers').scrollTop = editor.scrollTop;
    }
});

// Keep cursor position in status bar on click
editor.addEventListener('mouseup', updateCursorStat);