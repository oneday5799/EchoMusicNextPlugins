import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bytesToBase64,
  compareText,
  decodeHref,
  formatBytes,
  pad2,
  utf16Decode,
  utf8Decode,
  utf8Encode,
  xmlDecode,
} from '../plugins/webdav-music/src/codec.ts';
import {
  normalizeSettings,
  findLibrary,
  activeLibrary,
} from '../plugins/webdav-music/src/config.ts';
import {
  baseName,
  buildAuthUrl,
  encodePath,
  normalizeDir,
  normalizeServerUrl,
  parentPath,
  parsePropfind,
} from '../plugins/webdav-music/src/webdav.ts';
import { coverDataUrl, parseAudioTags } from '../plugins/webdav-music/src/tags.ts';
import {
  buildQueueTrack,
  compactSong,
  expandCompactSong,
  hash36,
  isAudioFile,
  makeSongId,
  makeSourceId,
  parseSourceId,
  parseTitleArtist,
  qualityForExtension,
  songFromEntry,
} from '../plugins/webdav-music/src/library.ts';
import {
  buildLrcFromKugou,
  formatLrcTime,
  pickLyricCandidate,
} from '../plugins/webdav-music/src/lrc.ts';

function utf8Bytes(text) {
  return utf8Encode(text);
}

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

test('base64 编码与 Node 行为一致', () => {
  const samples = ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar', '中文歌词✓'];
  for (const sample of samples) {
    assert.equal(bytesToBase64(utf8Bytes(sample)), Buffer.from(sample, 'utf8').toString('base64'));
  }
  const random = new Uint8Array(1024);
  for (let i = 0; i < random.length; i++) random[i] = (i * 37 + 11) & 0xff;
  assert.equal(bytesToBase64(random), Buffer.from(random).toString('base64'));
});

test('utf8Decode 覆盖 ASCII、多字节与截断回退', () => {
  const bytes = utf8Bytes('Hello 世界 — 🎵');
  assert.equal(utf8Decode(bytes), 'Hello 世界 — 🎵');
  assert.equal(utf8Decode(utf8Bytes('abc'), 1, 2), 'b');
  const truncated = utf8Bytes('中');
  assert.equal(utf8Decode(truncated, 0, 1).charCodeAt(0), 0xfffd);
});

test('utf8Encode 往返覆盖代理对', () => {
  const text = '路径/测试 🎧 A-Ω';
  const bytes = utf8Encode(text);
  assert.equal(utf8Decode(bytes), text);
  assert.deepEqual(Array.from(utf8Bytes(text)), Array.from(bytes));
});

test('utf16Decode 支持双端序', () => {
  const text = '中文abc';
  const little = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    little[i * 2] = text.charCodeAt(i) & 0xff;
    little[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  assert.equal(utf16Decode(little, 0, little.length, false), text);
  const big = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    big[i * 2] = text.charCodeAt(i) >> 8;
    big[i * 2 + 1] = text.charCodeAt(i) & 0xff;
  }
  assert.equal(utf16Decode(big, 0, big.length, true), text);
});

test('xmlDecode 与 decodeHref 还原转义', () => {
  assert.equal(xmlDecode('A&amp;B&lt;C&#x4E2D;'), 'A&B<C中');
  assert.equal(xmlDecode('plain'), 'plain');
  assert.equal(decodeHref('/%E9%9F%B3%E4%B9%90/a%20b.mp3'), '/音乐/a b.mp3');
  assert.equal(decodeHref('/plain/x.mp3'), '/plain/x.mp3');
});

test('pad2 与 formatBytes 输出', () => {
  assert.equal(pad2(3), '03');
  assert.equal(pad2(45), '45');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 5), '5.0 MB');
  assert.equal(formatBytes(-1), '');
});

test('compareText 数值感知排序', () => {
  const list = ['Track 10', 'Track 2', 'Track 1'];
  list.sort(compareText);
  assert.deepEqual(list, ['Track 1', 'Track 2', 'Track 10']);
});

test('normalizeSettings 归一化服务器地址并去重', () => {
  const settings = normalizeSettings({
    libraries: [
      { id: 'a', name: '主库', serverUrl: 'https://dav.example.com/', rootPath: '/music/' },
      { id: 'a', name: '重复', serverUrl: 'https://other/' },
      { id: '', name: '无 id' },
      { id: 'b', serverUrl: 'dav2.example.com' },
    ],
    activeLibraryId: 'missing',
    coverLyricSource: 'kugou',
  });
  assert.equal(settings.libraries.length, 2);
  assert.equal(settings.libraries[0].serverUrl, 'https://dav.example.com');
  assert.equal(settings.libraries[0].rootPath, '/music/');
  // normalizeLibrary only trims/strips trailing slashes; the https:// prefix
  // is added at request time by normalizeServerUrl.
  assert.equal(settings.libraries[1].serverUrl, 'dav2.example.com');
  assert.equal(settings.activeLibraryId, 'a');
  assert.equal(settings.coverLyricSource, 'kugou');
  const fallback = normalizeSettings(undefined);
  assert.deepEqual(fallback.libraries, []);
  assert.equal(fallback.activeLibraryId, null);
  assert.equal(fallback.coverLyricSource, 'embedded');
});

test('findLibrary 与 activeLibrary 回退', () => {
  const settings = normalizeSettings({
    libraries: [
      { id: 'a', serverUrl: 'https://a/' },
      { id: 'b', serverUrl: 'https://b/' },
    ],
    activeLibraryId: 'b',
  });
  assert.equal(findLibrary(settings, 'b').id, 'b');
  assert.equal(findLibrary(settings, 'zz'), null);
  assert.equal(findLibrary(settings, ''), null);
  assert.equal(activeLibrary(settings).id, 'b');
  assert.equal(
    activeLibrary({ libraries: [{ id: 'only', serverUrl: 'x' }], activeLibraryId: null }).id,
    'only',
  );
  assert.equal(activeLibrary({ libraries: [], activeLibraryId: null }), null);
});

test('normalizeDir 与 normalizeServerUrl 规整', () => {
  assert.equal(normalizeDir('music//中文/'), '/music/中文');
  assert.equal(normalizeDir('https://dav.host/dav'), '/dav');
  assert.equal(normalizeDir(''), '/');
  assert.equal(normalizeServerUrl('dav.example.com'), 'https://dav.example.com');
  assert.equal(normalizeServerUrl('http://x//'), 'http://x');
});

test('encodePath、baseName 与 buildAuthUrl', () => {
  assert.equal(
    encodePath('/音乐/我的 歌.mp3'),
    '/%E9%9F%B3%E4%B9%90/%E6%88%91%E7%9A%84%20%E6%AD%8C.mp3',
  );
  assert.equal(baseName('/a/b/c.mp3'), 'c.mp3');
  const url = buildAuthUrl('https://dav.example.com', 'user', 'p:ass', '/dir/x.mp3');
  assert.ok(url.startsWith('https://user:p%3Aass@dav.example.com/dir/x.mp3'));
  assert.equal(buildAuthUrl('https://dav.example.com', '', '', '/x'), 'https://dav.example.com/x');
});

test('parsePropfind 解析目录、文件与封面', () => {
  const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
   <d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
   <d:response><d:href>/dir/</d:href><d:propstat><d:prop><d:displayname>音乐</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
   <d:response><d:href>/a.mp3</d:href><d:propstat><d:prop><d:getcontentlength>2048</d:getcontentlength><d:getcontenttype>audio/mpeg</d:getcontenttype></d:prop></d:propstat></d:response>
   <d:response><d:href>/cover.jpg</d:href><d:propstat><d:prop><d:getcontentlength>10</d:getcontentlength></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const entries = parsePropfind(xml);
  assert.equal(entries.length, 4);
  const dir = entries.find((entry) => entry.path === '/dir');
  assert.equal(dir.isCollection, true);
  assert.equal(dir.name, '音乐');
  const file = entries.find((entry) => entry.path === '/a.mp3');
  assert.equal(file.isCollection, false);
  assert.equal(file.contentLength, 2048);
  assert.equal(parsePropfind('').length, 0);
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

test('isAudioFile 与歌曲 id 稳定性', () => {
  assert.equal(isAudioFile('a.MP3'), true);
  assert.equal(isAudioFile('b.txt'), false);
  assert.equal(isAudioFile('noext'), false);
  const id = makeSongId('lib', '/a.mp3');
  assert.equal(id, makeSongId('lib', '/a.mp3'));
  assert.notEqual(id, makeSongId('lib', '/b.mp3'));
  assert.ok(id.startsWith('webdav-'));
  const sourceId = makeSourceId('lib', id);
  assert.deepEqual(parseSourceId(sourceId), { libraryId: 'lib', songId: id });
  assert.equal(parseSourceId('other:lib:id'), null);
  assert.equal(hash36('abc'), hash36('abc'));
});

test('songFromEntry 与 buildQueueTrack 组装', () => {
  const song = songFromEntry({
    libraryId: 'lib',
    path: '/01 - A - B.mp3',
    name: '01 - A - B.mp3',
    size: 123,
  });
  assert.equal(song.title, 'B');
  assert.equal(song.artist, 'A');
  assert.equal(song.size, 123);
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
  assert.deepEqual(track.data, { p: song.path, l: 'lib', s: 123 });
});

test('compactSong 与 expandCompactSong 往返', () => {
  const song = songFromEntry({ libraryId: 'lib', path: '/x.mp3', name: 'x.mp3', size: 10 });
  const compact = compactSong(song);
  const expanded = expandCompactSong(compact);
  assert.deepEqual(expanded, song);
  assert.equal(expandCompactSong(['only', 'three']), null);
  assert.equal(expandCompactSong('text'), null);
});

test('ID3v2.3 文本帧使用 UTF-16 BOM 读取中文', () => {
  function frame(id, payload) {
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
  const tagSize =
    10 +
    textPayload('你好', 1).length +
    10 +
    textPayload('歌手', 1).length +
    10 +
    textPayload('专辑', 1).length;
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 3;
  header[6] = (tagSize >>> 21) & 0x7f;
  header[7] = (tagSize >>> 14) & 0x7f;
  header[8] = (tagSize >>> 7) & 0x7f;
  header[9] = tagSize & 0x7f;
  const body = new Uint8Array(tagSize);
  let offset = 0;
  for (const [id, text] of [
    ['TIT2', '你好'],
    ['TPE1', '歌手'],
    ['TALB', '专辑'],
  ]) {
    const payload = textPayload(text, 1);
    const part = frame(id, payload);
    body.set(part, offset);
    offset += part.length;
  }
  const bytes = new Uint8Array([...header, ...body]);
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
  const head = new Uint8Array(10);
  for (let i = 0; i < 4; i++) head[i] = 'USLT'.charCodeAt(i);
  head[4] = (lyricBody.length >>> 24) & 0xff;
  head[5] = (lyricBody.length >>> 16) & 0xff;
  head[6] = (lyricBody.length >>> 8) & 0xff;
  head[7] = lyricBody.length & 0xff;
  const header = new Uint8Array(10);
  header[0] = 0x49;
  header[1] = 0x44;
  header[2] = 0x33;
  header[3] = 3;
  const total = lyricBody.length + 10;
  header[6] = (total >>> 21) & 0x7f;
  header[7] = (total >>> 14) & 0x7f;
  header[8] = (total >>> 7) & 0x7f;
  header[9] = total & 0x7f;
  const bytes = new Uint8Array([...header, ...head, ...lyricBody]);
  const tags = parseAudioTags(bytes);
  assert.equal(tags.lyric, text);
});

test('FLAC STREAMINFO 时长 + Vorbis 小端注释块 + 封面', () => {
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

test('formatLrcTime 与 buildLrcFromKugou（间奏行裸时间戳）', () => {
  assert.equal(formatLrcTime(0), '[00:00.00]');
  assert.equal(formatLrcTime(65432), '[01:05.43]');
  const built = buildLrcFromKugou({
    lines: [
      { start_ms: 1000, text: '第一句', translation: 'first', romanization: 'di yi ju', words: [] },
      { start_ms: 2000, text: '', words: [] },
      { start_ms: 3000, text: '第二句', translation: '', romanization: '', words: [] },
    ],
  });
  assert.ok(built.content.includes('[00:01.00]第一句'));
  assert.ok(built.content.includes('[00:03.00]第二句'));
  assert.ok(built.translation.includes('[00:01.00]first'));
  assert.ok(built.translation.includes('[00:02.00]'));
  assert.ok(!built.translation.includes('[00:03.00]'));
  assert.ok(built.romanization.includes('[00:01.00]di yi ju'));
  assert.equal(buildLrcFromKugou({ lines: [] }), null);
});

test('pickLyricCandidate 偏好逐字与可滚动', () => {
  const candidates = [
    { source_id: 'a', access_key: 'k1', word_timed: false, scrollable: false, score: 0 },
    { source_id: 'b', access_key: 'k2', word_timed: true, scrollable: false, score: 0 },
    { source_id: 'c', access_key: 'k3', word_timed: false, scrollable: true, score: 5 },
    { source_id: '', access_key: 'k4' },
  ];
  assert.equal(pickLyricCandidate(candidates).source_id, 'b');
  assert.equal(pickLyricCandidate([]), null);
});
