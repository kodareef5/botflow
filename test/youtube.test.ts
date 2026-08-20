import assert from 'node:assert/strict';
import test from 'node:test';

import { youtubeThumbnailUrl, youtubeVideoId } from '../worker/src/youtube.ts';

test('youtube urls resolve to deterministic public thumbnail art', () => {
  const id = 'vskuiEs6CFA';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/shorts/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtu.be/${id}?t=15`,
    `http://youtube.com./v/${id}`,
  ]) {
    assert.equal(youtubeVideoId(url), id, url);
    assert.equal(youtubeThumbnailUrl(url), `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, url);
  }
});

test('youtube resolver rejects lookalikes, credentials, ports, and malformed paths', () => {
  for (const url of [
    'https://notyoutube.com/watch?v=vskuiEs6CFA',
    'https://youtube.com.evil.example/watch?v=vskuiEs6CFA',
    'https://www.youtube.com/channel/vskuiEs6CFA',
    'https://www.youtube.com/watch?v=too-short',
    'https://youtu.be/vskuiEs6CFA/extra',
    'https://youtube-nocookie.com/watch?v=vskuiEs6CFA',
    'https://user@youtube.com/watch?v=vskuiEs6CFA',
    'https://youtube.com:444/watch?v=vskuiEs6CFA',
    'javascript:https://youtu.be/vskuiEs6CFA',
  ]) assert.equal(youtubeVideoId(url), null, url);
});
