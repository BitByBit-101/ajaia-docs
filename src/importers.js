'use strict';

const path = require('path');
const mammoth = require('mammoth');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx'];
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

// Only tags the editor can represent; everything else is stripped.
const SANITIZE_OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'pre', 'code'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: { h4: 'h3', h5: 'h3', h6: 'h3' },
};

class ImportError extends Error {}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>'))
    .join('');
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw new ImportError('File looks binary, not plain text.');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

/**
 * Converts an uploaded file into sanitized HTML plus a suggested title.
 * @returns {Promise<{title: string, html: string}>}
 */
async function fileToHtml(originalName, buffer) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new ImportError(`Unsupported file type "${ext || 'unknown'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`);
  }
  if (!buffer || buffer.length === 0) throw new ImportError('File is empty.');

  let html;
  if (ext === '.txt') {
    html = textToHtml(decodeText(buffer));
  } else if (ext === '.md' || ext === '.markdown') {
    html = marked.parse(decodeText(buffer));
  } else {
    // .docx is a zip archive; check the magic bytes before handing to mammoth.
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new ImportError('File is not a valid .docx document.');
    }
    try {
      ({ value: html } = await mammoth.convertToHtml({ buffer }, { styleMap: ['u => u'] }));
    } catch {
      throw new ImportError('Could not read .docx file.');
    }
  }

  const clean = sanitizeHtml(html, SANITIZE_OPTIONS).trim();
  const title = path.basename(originalName, ext).trim().slice(0, 200) || 'Imported document';
  return { title, html: clean || '<p><br></p>' };
}

module.exports = { fileToHtml, ImportError, SUPPORTED_EXTENSIONS, MAX_UPLOAD_BYTES };
