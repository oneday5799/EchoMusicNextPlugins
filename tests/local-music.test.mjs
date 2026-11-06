import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bytesToBase64,
  compareText,
  pad2,
  utf16Decode,
  utf8Decode,
} from '../plugins/local-music/src/codec.ts';
import { normalizeSettings, findFolder } from '../plugins/local-music/src/config.ts';
import {
  albumKeyOf,
  baseName,
  buildQueueTrack,
  compactSong,
  dirNameOf,
  expandCompactSong,
  filterSongs,
  formatDuration,
  groupAlbums,
  hash36,
  isAudioFile,
  isCoverImage,
  isLyricFile,
  lyricKeyOf,
  makeSongId,
  makeSourceId,
  normalizeSortDescending,
  normalizeSortKey,
  parseSourceId,
  parseTitleArtist,
  qualityForExtension,
  sortSongs,
  songFromEntry,
} from '../plugins/local-music/src/library.ts';
import {
  coverDataUrl,
  id3TagSize,
  parseAudioTags,
  tagReadTarget,
} from '../plugins/local-music/src/tags.ts';
import { coerceJsonArray } from '../plugins/local-music/src/codec.ts';

function utf8Bytes(text) {
  const bytes = new Uint8Array(text.length * 4);
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      bytes[length] = code;
      length += 1;
    } else if (code < 2048) {
      bytes[length] = 192 | (code >> 6);
      bytes[length + 1] = 128 | (code & 63);
      length += 2;
    } else {
      bytes[length] = 224 | (code >> 12);
      bytes[length + 1] = 128 | ((code >> 6) & 63);
      bytes[length + 2] = 128 | (code & 63);
      length += 3;
    }
  }
  return bytes.subarray(0, length);
}

test('base64 编码与 Node 行为一致', () => {
  const samples = ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', '中文歌词✓'];
  for (const sample of samples) {
    assert.equal(bytesToBase64(utf8Bytes(sample)), Buffer.from(sample, 'utf8').toString('base64'));
  }
});

test('utf8Decode 与 utf16Decode 覆盖多字节与双端序', () => {
  assert.equal(utf8Decode(utf8Bytes('Hello 世界 — 🎵')), 'Hello 世界 — 🎵');
  assert.equal(utf8Decode(utf8Bytes('abc'), 1, 2), 'b');
  const text = '中文abc';
  const little = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    little[i * 2] = text.charCodeAt(i) & 0xff;
    little[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  assert.equal(utf16Decode(little, 0, little.length, false), text);
});

test('pad2 与 compareText', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(45), '45');
  const list = ['Track 10', 'Track 2', 'Track 1'];
  list.sort(compareText);
  assert.deepEqual(list, ['Track 1', 'Track 2', 'Track 10']);
});

test('normalizeSettings 去重并回退默认值', () => {
  const settings = normalizeSettings({
    folders: [
      { id: 'a', name: '音乐' },
      { id: 'a', name: '重复' },
      { id: '', name: '无 id' },
      { id: 'b' },
    ],
    readEmbedded: 'no',
    onlineFetch: true,
  });
  assert.deepEqual(settings.folders, [
    { id: 'a', name: '音乐', path: '' },
    { id: 'b', name: '', path: '' },
  ]);
  assert.equal(settings.readEmbedded, true);
  assert.equal(settings.onlineFetch, true);
  const fallback = normalizeSettings(undefined);
  assert.deepEqual(fallback.folders, []);
  assert.equal(fallback.readEmbedded, true);
  assert.equal(fallback.onlineFetch, false);
  assert.equal(findFolder(settings, 'a').name, '音乐');
  assert.equal(findFolder(settings, 'zz'), null);
  assert.equal(findFolder(settings, ''), null);
});

// The host io service can deliver JSON arrays as array-like objects that lost
// the JS Array prototype; persisted folders must survive that bridge.
test('normalizeSettings 接受失去 Array 原型的 folders', () => {
  const foldersLike = { length: 1, 0: { id: 'c', name: '曲库', path: 'E:/music' } };
  assert.equal(Array.isArray(foldersLike), false);
  const settings = normalizeSettings({ folders: foldersLike });
  assert.deepEqual(settings.folders, [{ id: 'c', name: '曲库', path: 'E:/music' }]);
  const keyedFolders = normalizeSettings({ folders: { 0: { id: 'd' }, 1: { id: 'e' } } });
  assert.deepEqual(
    keyedFolders.folders.map((folder) => folder.id),
    ['d', 'e'],
  );
  assert.deepEqual(normalizeSettings({ folders: {} }).folders, []);
  assert.deepEqual(normalizeSettings({ folders: null }).folders, []);
});

test('coerceJsonArray 还原策略', () => {
  assert.deepEqual(coerceJsonArray([1, 2]), [1, 2]);
  assert.deepEqual(coerceJsonArray({ length: 2, 0: 'x', 1: 'y' }), ['x', 'y']);
  assert.deepEqual(coerceJsonArray({ 0: 'a', 1: 'b' }), ['a', 'b']);
  assert.deepEqual(coerceJsonArray({}), []);
  assert.deepEqual(coerceJsonArray(undefined), []);
  assert.deepEqual(coerceJsonArray('text'), []);
  const sparse = { length: 3, 0: 'a', 2: 'c' };
  assert.deepEqual(coerceJsonArray(sparse), ['a', undefined, 'c']);
});

// The library cache stores each song as a 10-field array; a cache row read
// back through the host bridge may also arrive without the Array prototype.
test('expandCompactSong 接受伪数组的曲目', () => {
  const song = songFromEntry({ folderId: 'g1', path: '/x.mp3', name: 'x.mp3', size: 10 });
  song.album = '专辑';
  song.durationMs = 6500;
  song.lyricPath = '/x.lrc';
  const fields = compactSong(song);
  const arrayLike = { length: fields.length };
  fields.forEach(function (field, index) {
    arrayLike[index] = field;
  });
  assert.equal(Array.isArray(arrayLike), false);
  assert.deepEqual(expandCompactSong(arrayLike), song);
});

test('parseTitleArtist 与 qualityForExtension', () => {
  assert.deepEqual(parseTitleArtist('01 - Artist - Title.mp3'), {
    title: 'Title',
    artist: 'Artist',
  });
  assert.deepEqual(parseTitleArtist('Just A Song.flac'), { title: 'Just A Song', artist: '' });
  assert.equal(qualityForExtension('FLAC'), 'flac');
  assert.equal(qualityForExtension('m4a'), 'higher');
  assert.equal(qualityForExtension('xyz'), 'standard');
  assert.equal(qualityForExtension(123), 'standard');
});

test('isAudioFile、歌词与封面识别', () => {
  assert.equal(isAudioFile('a.MP3'), true);
  assert.equal(isAudioFile('b.txt'), false);
  assert.equal(isAudioFile('noext'), false);
  assert.equal(isLyricFile('a.lrc'), true);
  assert.equal(isLyricFile('a.txt'), true);
  assert.equal(isLyricFile('a.mp3'), false);
  assert.equal(isCoverImage('cover.jpg'), true);
  assert.equal(isCoverImage('Folder.PNG'), true);
  assert.equal(isCoverImage('front.webp'), true);
  assert.equal(isCoverImage('random.jpg'), false);
  assert.equal(isCoverImage('cover.gif'), false);
});

test('lyricKeyOf 配对歌曲与歌词文件', () => {
  assert.equal(lyricKeyOf('a/b/歌曲.mp3'), lyricKeyOf('a/b/歌曲.lrc'));
  assert.equal(lyricKeyOf('a/b/歌曲.mp3'), 'a/b|歌曲');
  assert.equal(baseName('a/b/c.mp3'), 'c.mp3');
  assert.equal(dirNameOf('a/b/c.mp3'), 'a/b');
  assert.equal(dirNameOf('c.mp3'), '');
});

test('歌曲 id 与 sourceId 稳定', () => {
  const id = makeSongId('g1', '/a.mp3');
  assert.equal(id, makeSongId('g1', '/a.mp3'));
  assert.notEqual(id, makeSongId('g1', '/b.mp3'));
  assert.ok(id.startsWith('local-'));
  const sourceId = makeSourceId('g1', id);
  assert.deepEqual(parseSourceId(sourceId), { folderId: 'g1', songId: id });
  assert.equal(parseSourceId('other:g1:id'), null);
  assert.equal(hash36('abc'), hash36('abc'));
});

test('songFromEntry 与 buildQueueTrack 组装', () => {
  const song = songFromEntry({
    folderId: 'g1',
    path: '/01 - A - B.mp3',
    name: '01 - A - B.mp3',
    size: 123,
  });
  assert.equal(song.title, 'B');
  assert.equal(song.artist, 'A');
  assert.equal(song.size, 123);
  assert.equal(song.album, '');
  const track = buildQueueTrack(song, {
    title: '',
    artist: '',
    album: '专辑',
    cover: 'data:image/png;base64,x',
    durationMs: 1500,
  });
  assert.equal(track.album, '专辑');
  assert.equal(track.durationMs, 1500);
  assert.equal(track.title, song.title);
  assert.equal(track.artist, song.artist);
  assert.deepEqual(track.data, { p: song.path, f: 'g1', s: 123 });
  song.lyricPath = '/01 - A - B.lrc';
  assert.deepEqual(buildQueueTrack(song).data, {
    p: song.path,
    f: 'g1',
    s: 123,
    ly: '/01 - A - B.lrc',
  });
});

test('parseSourceId 兼容宿主重写后的插件命名空间前缀', async () => {
  const { parseSourceId } = await import('../plugins/local-music/src/library.ts');
  assert.deepEqual(parseSourceId('local:g1:s-1'), { folderId: 'g1', songId: 's-1' });
  // EchoPluginPlaylist::parse prepends "<plugin-id>/" to queue sourceIds.
  assert.deepEqual(parseSourceId('local-music/local:g1:s-1'), {
    folderId: 'g1',
    songId: 's-1',
  });
  assert.deepEqual(parseSourceId('other/local:g1:s-1'), { folderId: 'g1', songId: 's-1' });
  assert.equal(parseSourceId('webdav:x'), null);
  assert.equal(parseSourceId(null), null);
});

test('queueCoverForTrack 按宿主队列上限裁剪封面', async () => {
  const { QUEUE_COVER_LIMIT, queueCoverForTrack } =
    await import('../plugins/local-music/src/entry.ts');
  const song = songFromEntry({ folderId: 'g1', path: '/x.mp3', name: 'x.mp3', size: 10 });
  const small = 'x'.repeat(QUEUE_COVER_LIMIT - 1);
  const kept = await queueCoverForTrack(song, small);
  assert.equal(kept.cover, small);
  const oversized = 'x'.repeat(QUEUE_COVER_LIMIT + 1);
  const withheld = await queueCoverForTrack(song, oversized);
  assert.equal(withheld.cover, undefined);
  assert.ok(withheld.id);
});

test('compactSong 与 expandCompactSong 往返', () => {
  const song = songFromEntry({ folderId: 'g1', path: '/x.mp3', name: 'x.mp3', size: 10 });
  song.album = '专辑';
  song.durationMs = 6500;
  song.lyricPath = '/x.lrc';
  const expanded = expandCompactSong(compactSong(song));
  assert.deepEqual(expanded, song);
  assert.equal(expandCompactSong(['only', 'three']), null);
  assert.equal(expandCompactSong('text'), null);
});

test('groupAlbums 分组、计数与代表曲目', () => {
  const a = songFromEntry({ folderId: 'g1', path: '/a1.mp3', name: 'a1.mp3', size: 1 });
  const b = songFromEntry({ folderId: 'g1', path: '/b1.mp3', name: 'b1.mp3', size: 2 });
  const c = songFromEntry({ folderId: 'g2', path: '/c1.mp3', name: 'c1.mp3', size: 3 });
  a.album = '专辑B';
  b.album = '专辑B';
  c.album = '';
  const albums = groupAlbums([a, b, c]);
  assert.equal(albums.length, 2);
  const albumB = albums.find((album) => album.name === '专辑B');
  const unknown = albums.find((album) => album.name === albumKeyOf(c));
  assert.ok(albumB && unknown);
  assert.equal(albumB.count, 2);
  assert.equal(albumB.representativeId, a.id);
  assert.equal(unknown.count, 1);
  assert.equal(unknown.representativeId, c.id);
});

test('filterSongs 与 sortSongs', () => {
  const a = songFromEntry({ folderId: 'g1', path: '/b.mp3', name: 'b.mp3', size: 5 });
  const b = songFromEntry({ folderId: 'g2', path: '/a.mp3', name: 'a.mp3', size: 9 });
  a.title = '天空';
  b.title = '海洋';
  b.artist = '歌手';
  assert.deepEqual(filterSongs([a, b], { folderId: 'g1' }), [a]);
  assert.deepEqual(filterSongs([a, b], { keyword: '海' }), [b]);
  assert.deepEqual(filterSongs([a, b], { keyword: '歌手' }), [b]);
  assert.deepEqual(filterSongs([a, b], { keyword: '不存在的词' }), []);
  // Title sort uses an ASCII pair: zh collation orders 海洋 before 天空.
  const c = songFromEntry({ folderId: 'g1', path: '/z.mp3', name: 'z.mp3', size: 1 });
  const d = songFromEntry({ folderId: 'g1', path: '/y.mp3', name: 'y.mp3', size: 2 });
  c.title = 'Banana';
  d.title = 'Apple';
  assert.deepEqual(sortSongs([c, d], 'title'), [d, c]);
  assert.deepEqual(sortSongs([c, d], 'title', true), [c, d]);
  assert.deepEqual(sortSongs([a, b], 'size'), [b, a]);
  assert.deepEqual(sortSongs([a, b], 'size', true), [a, b]);
  // b lives at /a.mp3, a at /b.mp3: filename order puts b first.
  assert.deepEqual(sortSongs([a, b], 'name'), [b, a]);
  a.durationMs = 3000;
  b.durationMs = 1500;
  assert.deepEqual(sortSongs([a, b], 'duration'), [b, a]);
  assert.equal(normalizeSortDescending(2), true);
  assert.equal(normalizeSortDescending(1), false);
  assert.equal(normalizeSortDescending(undefined), false);
  assert.equal(normalizeSortDescending('desc'), true);
  assert.equal(normalizeSortKey('size'), 'size');
  assert.equal(normalizeSortKey('bogus'), 'title');
  assert.equal(normalizeSortKey(undefined), 'title');
});

test('formatDuration 输出', () => {
  assert.equal(formatDuration(6400), '0:06');
  assert.equal(formatDuration(65000), '1:05');
  assert.equal(formatDuration(0), '');
});

// ID3 text frame payload: encoding byte (1 = UTF-16 with BOM), then the BOM,
// then UTF-16LE characters.
function textPayload(text, encoding) {
  if (encoding === 1) {
    const body = new Uint8Array(3 + text.length * 2);
    body[0] = 1;
    body[1] = 0xff;
    body[2] = 0xfe;
    for (let i = 0; i < text.length; i++) {
      body[3 + i * 2] = text.charCodeAt(i) & 0xff;
      body[4 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return body;
  }
  return utf8Bytes(text);
}

function id3Frame(id, payload) {
  const head = new Uint8Array(10);
  for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
  head[4] = (payload.length >>> 24) & 0xff;
  head[5] = (payload.length >>> 16) & 0xff;
  head[6] = (payload.length >>> 8) & 0xff;
  head[7] = payload.length & 0xff;
  const out = new Uint8Array(10 + payload.length);
  out.set(head, 0);
  out.set(payload, 10);
  return out;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function id3Header(bodyLength) {
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 3;
  header[6] = (bodyLength >>> 21) & 0x7f;
  header[7] = (bodyLength >>> 14) & 0x7f;
  header[8] = (bodyLength >>> 7) & 0x7f;
  header[9] = bodyLength & 0x7f;
  return header;
}

function flacBlock(type, payload, last) {
  const head = new Uint8Array(4);
  head[0] = (last ? 0x80 : 0) | type;
  head[1] = (payload.length >>> 16) & 0xff;
  head[2] = (payload.length >>> 8) & 0xff;
  head[3] = payload.length & 0xff;
  return concatBytes([head, payload]);
}

function flacStreamInfo(durationMs) {
  // 34-byte STREAMINFO with only the sample rate (44100) and total samples
  // filled; everything else stays zero.
  const stream = new Uint8Array(34);
  const view = new DataView(stream.buffer);
  stream[10] = 0x0a;
  stream[11] = 0xc4;
  stream[12] = 0x40;
  view.setUint32(14, Math.round((44100 * durationMs) / 1000));
  return stream;
}

function flacComments(entries) {
  const vendor = utf8Bytes('test');
  const parts = entries.map((entry) => utf8Bytes(entry));
  const total = 8 + vendor.length + parts.reduce((sum, part) => sum + 4 + part.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, vendor.length, true);
  out.set(vendor, 4);
  view.setUint32(4 + vendor.length, parts.length, true);
  let offset = 8 + vendor.length;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

function flacPicture(mime, data) {
  // Layout consumed by readFlacPicture: 4-byte picture type, MIME length +
  // MIME, description length, 16 bytes of dimensions, data length, data.
  const mimeBytes = utf8Bytes(mime);
  const out = new Uint8Array(32 + mimeBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(4, mimeBytes.length);
  out.set(mimeBytes, 8);
  view.setUint32(8 + mimeBytes.length, 0);
  view.setUint32(28 + mimeBytes.length, data.length);
  out.set(data, 32 + mimeBytes.length);
  return out;
}

test('id3TagSize 读取声明尺寸', () => {
  const payload = textPayload('你好', 1);
  const bytes = concatBytes([id3Header(payload.length), id3Frame('TIT2', payload)]);
  assert.equal(id3TagSize(bytes), payload.length);
  assert.equal(id3TagSize(new Uint8Array(10)), -1);
});

test('ID3v2.3 文本帧使用 UTF-16 BOM 读取中文', () => {
  const parts = [
    id3Frame('TIT2', textPayload('你好', 1)),
    id3Frame('TPE1', textPayload('歌手', 1)),
    id3Frame('TALB', textPayload('专辑', 1)),
  ];
  const bodyLength = parts.reduce((total, part) => total + part.length, 0);
  const bytes = concatBytes([id3Header(bodyLength), ...parts]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.title, '你好');
  assert.equal(tags.artist, '歌手');
  assert.equal(tags.album, '专辑');
});

test('USLT 同步歌词（chi 语言描述符 + UTF-16 BOM）', () => {
  const text = '[00:01.00]你好';
  const lyricText = textPayload(text, 1).slice(1);
  const lyricBody = new Uint8Array(6 + lyricText.length);
  lyricBody[0] = 1;
  lyricBody[1] = 0x63;
  lyricBody[2] = 0x68;
  lyricBody[3] = 0x69;
  lyricBody[4] = 0;
  lyricBody[5] = 0;
  lyricBody.set(lyricText, 6);
  const frame = id3Frame('USLT', lyricBody);
  const bytes = concatBytes([id3Header(frame.length), frame]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.lyric, text);
});

function id3HeaderMajor(major, bodyLength, flags) {
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = major;
  header[5] = flags || 0;
  header[6] = (bodyLength >>> 21) & 0x7f;
  header[7] = (bodyLength >>> 14) & 0x7f;
  header[8] = (bodyLength >>> 7) & 0x7f;
  header[9] = bodyLength & 0x7f;
  return header;
}

function syncsafeBytes(value) {
  const out = new Uint8Array(4);
  out[0] = (value >>> 21) & 0x7f;
  out[1] = (value >>> 14) & 0x7f;
  out[2] = (value >>> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function id3Frame24(id, flags2, body) {
  const head = new Uint8Array(10);
  for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
  head[4] = (body.length >>> 21) & 0x7f;
  head[5] = (body.length >>> 14) & 0x7f;
  head[6] = (body.length >>> 7) & 0x7f;
  head[7] = body.length & 0x7f;
  head[9] = flags2;
  const out = new Uint8Array(10 + body.length);
  out.set(head, 0);
  out.set(body, 10);
  return out;
}

function id3Frame22(id, payload) {
  const head = new Uint8Array(6);
  for (let i = 0; i < 3; i++) head[i] = id.charCodeAt(i);
  head[3] = (payload.length >>> 16) & 0xff;
  head[4] = (payload.length >>> 8) & 0xff;
  head[5] = payload.length & 0xff;
  const out = new Uint8Array(6 + payload.length);
  out.set(head, 0);
  out.set(payload, 6);
  return out;
}

/** 写入端 unsynchronisation：每个 0xFF 后补一个 0x00。 */
function unsynchronise(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff) out.push(0x00);
  }
  return new Uint8Array(out);
}

function apicPayload(art) {
  const payload = new Uint8Array(14 + art.length);
  payload[0] = 0; // latin-1
  payload.set(utf8Bytes('image/jpeg'), 1);
  payload[11] = 0; // mime 终止
  payload[12] = 3; // front cover
  payload[13] = 0; // 空描述终止
  payload.set(art, 14);
  return payload;
}

test('ID3v2.4 扩展头按 syncsafe 语义跳过', () => {
  // 扩展头声明 6 字节且该值含 4 个长度字节本身：第一帧应落在 10+6。
  const ext = concatBytes([syncsafeBytes(6), new Uint8Array([1, 0])]);
  const payload = concatBytes([new Uint8Array([3]), utf8Bytes('标题')]);
  const frame = id3Frame('TIT2', payload);
  const bytes = concatBytes([id3HeaderMajor(4, ext.length + frame.length, 0x40), ext, frame]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.title, '标题');
});

test('ID3v2.3 标签级 unsynchronisation 恢复封面字节', () => {
  const art = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const frame = id3Frame('APIC', apicPayload(art));
  const body = unsynchronise(frame);
  const bytes = concatBytes([id3HeaderMajor(3, body.length, 0x80), body]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.coverMime, 'image/jpeg');
  assert.deepEqual(Array.from(tags.coverData), Array.from(art));
});

test('ID3v2.4 帧级 unsynchronisation 与数据长度指示器', () => {
  const art = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22]);
  // 帧体 = 4 字节 syncsafe 原始长度 + unsynchronised 内容；
  // 帧尺寸字段按存储字节计（含插入字节与长度指示器）。
  const body = concatBytes([syncsafeBytes(14 + art.length), unsynchronise(apicPayload(art))]);
  const frame = id3Frame24('APIC', 0x03, body);
  const bytes = concatBytes([id3HeaderMajor(4, frame.length), frame]);
  const tags = parseAudioTags(bytes);
  assert.deepEqual(Array.from(tags.coverData), Array.from(art));
});

test('ID3v2.2 标签解析（TT2 文本与 PIC 封面）', () => {
  const title = id3Frame22('TT2', new Uint8Array([0, 84, 105, 116, 108, 101]));
  const art = new Uint8Array([0xff, 0xd8, 0x11, 0x22]);
  const pic = new Uint8Array(6 + art.length);
  pic[0] = 0; // latin-1
  pic.set(utf8Bytes('JPG'), 1);
  pic[4] = 3; // front cover
  pic[5] = 0; // 空描述终止
  pic.set(art, 6);
  const frames = [title, id3Frame22('PIC', pic)];
  const bodyLength = frames.reduce((total, part) => total + part.length, 0);
  const bytes = concatBytes([id3HeaderMajor(2, bodyLength), ...frames]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.title, 'Title');
  assert.equal(tags.coverMime, 'image/jpg');
  assert.deepEqual(Array.from(tags.coverData), Array.from(art));
});

test('APIC UTF-16 描述缺失终止符时不产出垃圾封面', () => {
  // 描述按 UTF-16 BOM 写入但永不结束：封面应判 null 而非把描述当图像数据。
  const desc = new Uint8Array([0xff, 0xfe, 0x01, 0x5c, 0x62, 0x97]);
  const payload = new Uint8Array(1 + 10 + 1 + 1 + desc.length);
  payload[0] = 1;
  payload.set(utf8Bytes('image/jpeg'), 1);
  payload[11] = 0;
  payload[12] = 3;
  payload.set(desc, 13);
  const frame = id3Frame('APIC', payload);
  const bytes = concatBytes([id3Header(frame.length), frame]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.coverData, null);
});

test('FLAC STREAMINFO 时长 + Vorbis 注释 + 封面', () => {
  function block(type, payload, last) {
    const head = new Uint8Array(4);
    head[0] = (last ? 0x80 : 0) | type;
    head[1] = (payload.length >>> 16) & 0xff;
    head[2] = (payload.length >>> 8) & 0xff;
    head[3] = payload.length & 0xff;
    const out = new Uint8Array(4 + payload.length);
    out.set(head, 0);
    out.set(payload, 4);
    return out;
  }
  const magic = utf8Bytes('fLaC');
  const stream = new Uint8Array(34);
  const view = new DataView(stream.buffer);
  stream[10] = 0x0a;
  stream[11] = 0xc4;
  stream[12] = 0x40;
  view.setUint32(14, 44100 * 5);
  const vendor = utf8Bytes('test');
  const comment = utf8Bytes('TITLE=歌名');
  const comments = new Uint8Array(16 + vendor.length + comment.length);
  const cv = new DataView(comments.buffer);
  cv.setUint32(0, vendor.length, true);
  comments.set(vendor, 4);
  cv.setUint32(4 + vendor.length, 1, true);
  cv.setUint32(8 + vendor.length, comment.length, true);
  comments.set(comment, 12 + vendor.length);
  const mime = utf8Bytes('image/png');
  const picture = new Uint8Array(8 + mime.length + 4 + 16 + 8);
  const pv = new DataView(picture.buffer);
  pv.setUint32(4, mime.length);
  picture.set(mime, 8);
  pv.setUint32(8 + mime.length, 0);
  pv.setUint32(28 + mime.length, 4);
  picture.set(new Uint8Array([1, 2, 3, 4]), 32 + mime.length);
  const bytes = new Uint8Array([
    ...magic,
    ...block(0, stream, false),
    ...block(4, comments, false),
    ...block(6, picture, true),
  ]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.title, '歌名');
  assert.equal(tags.durationMs, 5000);
  assert.equal(tags.coverMime, 'image/png');
  assert.deepEqual(Array.from(tags.coverData), [1, 2, 3, 4]);
  assert.ok(coverDataUrl(tags).startsWith('data:image/png;base64,'));
  assert.equal(coverDataUrl({ coverData: null, coverMime: '' }), '');
});

test('FLAC 封面块超出探测窗口：tagReadTarget 报出声明范围，重读后可解析', () => {
  const art = new Uint8Array(300 * 1024);
  for (let i = 0; i < art.length; i++) art[i] = (i * 31 + 7) & 0xff;
  const bytes = concatBytes([
    utf8Bytes('fLaC'),
    flacBlock(0, flacStreamInfo(5000), false),
    flacBlock(4, flacComments(['TITLE=歌名']), false),
    flacBlock(6, flacPicture('image/png', art), true),
  ]);
  const probe = bytes.slice(0, 256 * 1024);
  const probeTags = parseAudioTags(probe);
  assert.equal(probeTags.title, '歌名');
  assert.equal(probeTags.durationMs, 5000);
  assert.equal(probeTags.coverData, null);
  const target = tagReadTarget(probe);
  assert.ok(target > probe.length);
  assert.equal(target, bytes.length);
  // 模拟按声明范围重读后的窗口：恰好容纳完整封面块。
  const tags = parseAudioTags(bytes.slice(0, target));
  assert.equal(tags.coverMime, 'image/png');
  assert.equal(tags.coverData.length, art.length);
  assert.equal(tags.coverData[0], art[0]);
  assert.equal(tags.coverData[art.length - 1], art[art.length - 1]);
});

test('前置 ID3 的 FLAC：合并 ID3 文本与 FLAC 原生封面', () => {
  const art = new Uint8Array([9, 8, 7, 6]);
  const id3Payload = concatBytes([
    id3Frame('TIT2', textPayload('ID3标题', 1)),
    id3Frame('TPE1', textPayload('ID3歌手', 1)),
  ]);
  const bytes = concatBytes([
    id3Header(id3Payload.length),
    id3Payload,
    utf8Bytes('fLaC'),
    flacBlock(0, flacStreamInfo(5000), false),
    flacBlock(4, flacComments(['ALBUM=FLAC专辑']), false),
    flacBlock(6, flacPicture('image/png', art), true),
  ]);
  // 头部都在窗口内时无需重读。
  assert.equal(tagReadTarget(bytes), 0);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.title, 'ID3标题');
  assert.equal(tags.artist, 'ID3歌手');
  assert.equal(tags.album, 'FLAC专辑');
  assert.equal(tags.durationMs, 5000);
  assert.equal(tags.coverMime, 'image/png');
  assert.deepEqual(Array.from(tags.coverData), [9, 8, 7, 6]);
});
