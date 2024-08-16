import { Link, Redirect } from '../components/router.js'
import { o } from '../jsx/jsx.js'
import { prerender } from '../jsx/html.js'
import Comment from '../components/comment.js'
import SourceCode from '../components/source-code.js'
import youtubeAPI, {
  GetDataResult,
  GetVideoDetailsResult,
  NextPageData,
  VideoItem,
} from 'youtube-search-api'
import { genTsType } from 'gen-ts-type'
import { getContextSearchParams, Routes, StaticPageRoute } from '../routes.js'
import { apiEndpointTitle, config, title } from '../../config.js'
import { Context, DynamicContext } from '../context.js'
import { mapArray } from '../components/fragment.js'
import Style from '../components/style.js'
import {
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import pfs from 'fs/promises'
import { HOUR } from '@beenotung/tslib/time.js'
import { renderError } from '../components/error.js'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import express, { Router } from 'express'
import { getWSSession, sessions } from '../session.js'
import { ServerMessage } from '../../../client/types.js'
import { nodeToVElementOptimized } from '../jsx/vnode.js'

let searchVideoStyle = Style(/* css */ `
#home form {
  width: fit-content;
}
#home form hr {
  border-color: #0005;
}
label.field {
  display: block;
  margin: 0.25rem 0;
}
label.field input {
  display: block;
  margin-top: 0.25rem;
}
.or-line {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.or-line hr {
  height: 0;
  width: 100%;
}
`)
let searchVideos = (
  <div id="home">
    {searchVideoStyle}
    <h2>Search Videos</h2>
    <form method="get" action="/search">
      <label class="field">
        Keywords:
        <input type="text" name="q" />
      </label>
      <div class="or-line">
        <hr />
        or
        <hr />
      </div>
      <label class="field">
        Url / ID:
        <input type="text" name="url" />
      </label>
      <hr />
      <input type="submit" value="Search" style="margin: 0.5rem 0" />
    </form>
  </div>
)

async function callAPI<T>(cacheFile: string, fn: () => T): Promise<T> {
  if (config.development && existsSync(cacheFile)) {
    let text = readFileSync(cacheFile).toString()
    return JSON.parse(text)
  }
  let result = await fn()
  if (config.development) {
    let text = JSON.stringify(result, null, 2)
    writeFileSync(cacheFile, text)
  }
  return result
}

function callTextAPI<T>(cacheFile: string, fn: () => string): string {
  if (config.development && existsSync(cacheFile)) {
    let text = readFileSync(cacheFile).toString()
    return text
  }
  let text = fn()
  if (config.development) {
    writeFileSync(cacheFile, text)
  }
  return text
}

let resolveSearch = async (
  context: DynamicContext,
): Promise<StaticPageRoute> => {
  const keyword = getContextSearchParams(context).get('q')
  const url = getContextSearchParams(context).get('url')
  if (url) {
    let id = new URLSearchParams(url.split('?').pop()).get('v') || url
    return {
      title: apiEndpointTitle,
      description: 'Redirect to video page',
      node: <Redirect href={`/video/${id}`} />,
    }
  }
  if (!keyword) {
    return {
      title: title('Search Videos'),
      description: 'Search videos to download by keywords',
      node: <Redirect href="/" />,
    }
  }
  try {
    const withPlaylist = false
    const limit = undefined
    const result: GetDataResult = await callAPI('result.json', () =>
      youtubeAPI.GetListByKeyword(keyword, withPlaylist, limit, [
        { type: 'video' },
      ]),
    )
    return {
      title: title('Search Result of ' + keyword),
      description: 'Videos search result of the keyword: ' + keyword,
      node: SearchResult({ keyword, result }, context),
    }
  } catch (error) {
    return {
      title: title('Search Result of ' + keyword),
      description: 'Videos search result of the keyword: ' + keyword,
      node: renderError(error, context),
    }
  }
}

let nextPageCache = new Map<
  number,
  { keyword: string; nextPage: NextPageData }
>()
let nextPageIdCounter = 0

let searchResultStyle = Style(/* css */ `
#results .video-list {
  display: flex;
  flex-direction: column;
  width: fit-content;
  max-width: calc(360px + 1rem)
}
#results .video-item {
  border: 1px solid black;
  padding: 0.5rem;
}
#results .video-item img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
`)
function SearchResult(
  attrs: {
    keyword: string
    result: GetDataResult
  },
  context: DynamicContext,
) {
  let videos = (attrs.result.items as VideoItem[]).filter(
    item => item.type === 'video',
  )
  nextPageIdCounter++
  let nextPageId = nextPageIdCounter
  nextPageCache.set(nextPageId, {
    keyword: attrs.keyword,
    nextPage: attrs.result.nextPage,
  })
  setTimeout(() => {
    nextPageCache.delete(nextPageId)
  }, 3 * HOUR)
  return (
    <div id="results">
      {searchResultStyle}
      <h2>Search Result of "{attrs.keyword}"</h2>
      <div class="video-list">
        {mapArray(videos, video => {
          let thumbnail = video.thumbnail.thumbnails[0]
          return (
            <a class="video-item" href={'/video/' + video.id}>
              <div className="video-thumbnail">
                {thumbnail ? (
                  <img
                    loading="lazy"
                    width={thumbnail.width + 'px'}
                    height={thumbnail.height + 'px'}
                    src={thumbnail.url}
                  />
                ) : null}
              </div>
              <div className="video-title">{video.title}</div>
            </a>
          )
        })}
      </div>
      <p>
        <Link href={'/more-result/' + nextPageId}>Show more result</Link>
      </p>
    </div>
  )
}

let resolveMoreResult = async (
  context: DynamicContext,
): Promise<StaticPageRoute> => {
  let id = +context.routerMatch?.params?.id
  let cache = nextPageCache.get(id)
  if (!cache) {
    return {
      title: title('Search Videos'),
      description: 'Search videos to download by keywords',
      node: <Redirect href="/" />,
    }
  }
  let { keyword, nextPage } = cache
  try {
    const withPlaylist = false
    const limit = undefined
    const result = await callAPI(`result-${id}.json`, () =>
      youtubeAPI.NextPage(nextPage, withPlaylist, limit),
    )
    return {
      title: title('Search Result of ' + keyword),
      description: 'Videos search result of the keyword: ' + keyword,
      node: SearchResult({ keyword, result }, context),
    }
  } catch (error) {
    return {
      title: title('Search Result of ' + keyword),
      description: 'Videos search result of the keyword: ' + keyword,
      node: renderError(error, context),
    }
  }
}

let downloadDir = 'downloads'
mkdirSync(downloadDir, { recursive: true })

pfs
  .readdir(downloadDir)
  .then(files => files.forEach(filename => startDeleteTimer(filename)))

async function casualGetVideoDetail(
  video_id: string,
): Promise<GetVideoDetailsResult> {
  let detail: GetVideoDetailsResult
  try {
    detail = await callAPI('result-' + video_id + '.json', () =>
      youtubeAPI.GetVideoDetails(video_id),
    )
  } catch (error) {
    detail = {
      title: video_id,
      isLive: false,
      channel: '',
      description: undefined,
      suggestion: [],
    }
  }
  return detail
}

// url -> output text
let formatCache = new Map<string, string>()
function cachedQueryFormat(url: string): string {
  let output = formatCache.get(url)
  if (output) return output
  let result = spawnSync('yt-dlp', ['-F', url])
  output = result.stdout.toString()
  formatCache.set(url, output)
  return output
}

let resolveVideo = async (
  context: DynamicContext,
): Promise<StaticPageRoute> => {
  let video_id = context.routerMatch?.params?.id

  let detail = await casualGetVideoDetail(video_id)
  let video_title = detail.title

  let files = await pfs.readdir(downloadDir)
  let filename = files.find(f => f.includes(video_id))
  if (filename) {
    return {
      title: title('Download Video: ' + video_title),
      description: 'this video is cached',
      node: DownloadVideo({ video_id, detail, filename }),
    }
  }
  let url = 'https://www.youtube.com/watch?v=' + video_id
  let output = callTextAPI('result-format.txt', () => {
    return cachedQueryFormat(url)
  })
  let formats: Format[] = []
  try {
    formats = parseFormats(output)
  } catch (error) {
    console.error('failed to parse format')
    console.error(error)
    console.error('format text:')
    console.error(output)
  }
  if (formats.length == 0) {
    formatCache.delete(url)
    formats = fallbackFormats
  }
  return {
    title: title('New Video: ' + video_title),
    description: 'this video is not cached yet',
    node: NewVideoPage({ video_id, formats, detail }),
  }
}

type Format = {
  id: string
  ext: string
  resolution: string
  fps: string
  file_size: string
  remark: string
}

function parseFormats(text: string): Format[] {
  let lines = text.split('\n')
  let startIdx = lines.findIndex(line =>
    line.startsWith('------------------------'),
  )
  let formats = lines
    .slice(startIdx + 1)
    .filter(line => line.length > 0)
    .map((line): Format => {
      line = line
        .replace('audio only', 'audio_only')
        .replace('video only', 'video_only')
      let parts = line
        .split('|')
        .map(part => part.split(' ').filter(part => part.length > 0))
        .filter(parts => parts.length > 0)
      let id = parts[0][0]
      let ext = parts[0][1]
      let resolution = parts[0][2]
      if (resolution == 'audio_only') {
        resolution = ''
      }
      let fps = parts[0][3]
      let file_size = parts[1][0]
      if (file_size == '~' || file_size == '≈') {
        file_size += parts[1][1]
      } else if (file_size == 'm3u8') {
        file_size = '(streaming)'
      }
      let remark = line.includes('audio_only')
        ? 'audio only'
        : line.includes('video_only')
        ? 'video only'
        : ''
      return { id, ext, resolution, fps, file_size, remark }
    })
    .filter(format => format.file_size && format.ext !== 'mhtml')
  return formats
}

let fallbackFormats: Format[] = [
  {
    id: '233',
    ext: 'mp4',
    resolution: '',
    fps: '',
    file_size: '(streaming)',
    remark: 'audio only',
  },
  {
    id: '234',
    ext: 'mp4',
    resolution: '',
    fps: '',
    file_size: '(streaming)',
    remark: 'audio only',
  },
  {
    id: '139',
    ext: 'm4a',
    resolution: '',
    fps: '2',
    file_size: '',
    remark: 'audio only',
  },
  {
    id: '140',
    ext: 'm4a',
    resolution: '',
    fps: '2',
    file_size: '',
    remark: 'audio only',
  },
  {
    id: '251',
    ext: 'webm',
    resolution: '',
    fps: '2',
    file_size: '',
    remark: 'audio only',
  },
  {
    id: '269',
    ext: 'mp4',
    resolution: '256x144',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '160',
    ext: 'mp4',
    resolution: '256x144',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '230',
    ext: 'mp4',
    resolution: '640x360',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '134',
    ext: 'mp4',
    resolution: '640x360',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '18',
    ext: 'mp4',
    resolution: '640x360',
    fps: '24',
    file_size: '',
    remark: '',
  },
  {
    id: '605',
    ext: 'mp4',
    resolution: '640x360',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '232',
    ext: 'mp4',
    resolution: '1280x720',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
  {
    id: '136',
    ext: 'mp4',
    resolution: '1280x720',
    fps: '24',
    file_size: '',
    remark: 'video only',
  },
]

let videoPageStyle = Style(/* css */ `
#videoPage table {
  border-collapse: collapse
}
#videoPage th,
#videoPage td {
  border: 1px solid black;
  padding: 0.25rem;
}
`)

function NewVideoPage(attrs: {
  video_id: string
  detail: GetVideoDetailsResult
  formats: Format[]
}) {
  let { video_id, detail, formats } = attrs

  // avoid IP-ban
  formats = formats.filter(format => format.file_size !== '(streaming)')

  return (
    <div id="videoPage">
      {videoPageStyle}
      <h2>{detail.title}</h2>
      <p>{detail.description}</p>
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>ext</th>
            <th>resolution</th>
            <th>fps/ch</th>
            <th>file size</th>
            <th>remark</th>
            <th>action</th>
          </tr>
        </thead>
        <tbody>
          {mapArray(formats, format => (
            <tr>
              <td>{format.id}</td>
              <td>{format.ext}</td>
              <td>{format.resolution}</td>
              <td>{format.fps}</td>
              <td>{format.file_size}</td>
              <td>{format.remark}</td>
              <td>
                <Link href={'/download/' + video_id + '/' + format.id}>
                  <button>Download</button>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {formats.length == 0 ? (
        <p>No formats are available at the moment.</p>
      ) : null}
    </div>
  )
}

let resolveDownloadVideo = async (
  context: DynamicContext,
): Promise<StaticPageRoute> => {
  let currentUrl = context.url
  let params = context.routerMatch?.params

  let video_id = params?.video_id
  let format_id = params?.format_id

  let detail = await casualGetVideoDetail(video_id)
  let video_title = detail.title

  let files = await pfs.readdir(downloadDir)
  let filename = files.find(f => f.includes(video_id))

  if (!filename) {
    let child = spawn(
      'yt-dlp',
      ['-f', format_id, 'https://www.youtube.com/watch?v=' + video_id],
      { cwd: downloadDir },
    )
    child.stdout.on('data', chunk => {
      let line = chunk.toString().trim()
      if (!line.startsWith('[download]')) return
      let message: ServerMessage = ['update-text', '#downloadProgress', line]
      sessions.forEach(session => {
        if (session.url !== currentUrl) return
        session.ws.send(message)
      })
    })
    child.on('exit', async exit_code => {
      console.log('download ended:', { video_id, exit_code })
      if (exit_code !== 0) return

      let files = await pfs.readdir(downloadDir)
      let filename = files.find(f => f.includes(video_id))
      if (!filename) return

      let node = DownloadVideo({ video_id, detail, filename })
      let element = nodeToVElementOptimized(node, context)
      let message: ServerMessage = ['update-in', '#downloadPage', element]

      sessions.forEach(session => {
        if (session.url !== currentUrl) return
        session.ws.send(message)
      })
    })
  }

  return {
    title: title('Download Video: ' + video_title),
    description: 'this video is cached',
    node: DownloadVideo({ video_id, detail, filename }),
  }
}

function DownloadVideo(attrs: {
  video_id: string
  detail: GetVideoDetailsResult
  filename: string | undefined
}) {
  let { video_id, detail, filename } = attrs
  if (filename) {
    startDeleteTimer(filename)
  }
  return (
    <div id="downloadPage">
      <h2>{detail.title}</h2>
      <p>{detail.description}</p>
      {!filename ? (
        <>
          <p>loading video...</p>
          <p id="downloadProgress"></p>
        </>
      ) : (
        <>
          <p>Video ready: {filename}</p>
          <p>
            <a href={'/downloads/' + filename} download={filename}>
              Download
            </a>
          </p>
          <p>
            <a href={'/downloads/' + filename}>View</a>
          </p>
        </>
      )}
    </div>
  )
}

type Timer = ReturnType<typeof setTimeout>

let deleteTimers = new Map<string, Timer>()

function startDeleteTimer(filename: string) {
  let timer = deleteTimers.get(filename)
  if (timer) {
    clearTimeout(timer)
  }
  timer = setTimeout(() => {
    pfs
      .unlink(join(downloadDir, filename))
      .then(() => {
        console.log('deleted', filename)
      })
      .catch(error => {
        console.error('failed to delete', { filename, error })
      })
  }, 3 * HOUR)
  deleteTimers.set(filename, timer)
}

let routes: Routes = {
  '/': {
    title: title('Search Videos'),
    description: 'Search videos to download by keywords',
    menuText: 'Search',
    menuUrl: '/',
    node: searchVideos,
  },
  '/search': {
    resolve: resolveSearch,
    streaming: false,
  },
  '/more-result/:id': {
    resolve: resolveMoreResult,
    streaming: false,
  },
  '/video/:id': {
    resolve: resolveVideo,
    streaming: false,
  },
  '/download/:video_id/:format_id': {
    resolve: resolveDownloadVideo,
    streaming: false,
  },
}

setTimeout(() => {
  config.development = false
}, 1000)

let middleware = Router()
middleware.use('/downloads', express.static(downloadDir))

export default { routes, middleware }
