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
import { config, title } from '../../config.js'
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

let searchVideos = (
  <div id="home">
    <h2>Search Videos</h2>
    <form method="get" action="/search">
      <label>
        Keywords <input type="text" name="q" />
      </label>{' '}
      <input type="submit" value="Search" />
    </form>
  </div>
)

function submit() {
  youtubeAPI
    .GetListByKeyword('flower', undefined, undefined, [{ type: 'video' }])
    .then(res => {
      console.log('res:', res)
      let type = genTsType(res, { format: true })
      console.log('type:', type)
    })
    .catch(err => {
      console.log('err:', err)
    })
}

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
      <p>Number of results: {videos.length}</p>
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
  console.log({ id, cache: !!cache })
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
  let output = callTextAPI('result-format.txt', () => {
    let result = spawnSync('yt-dlp', [
      '-F',
      'https://www.youtube.com/watch?v=' + video_id,
    ])
    let output = result.stdout.toString()
    return output
  })
  let lines = output.split('\n')
  let startIdx = lines.findIndex(line =>
    line.startsWith('------------------------'),
  )
  // console.log({startIdx})
  let formats = lines
    .slice(startIdx + 1)
    .filter(line => line.length > 0 && !line.includes(' only'))
    .map((line): Format => {
      let parts = line.split(' ').filter(part => part.length > 0)
      let id = parts[0]
      let ext = parts[1]
      let resolution = parts[2]
      let fps = parts[3]
      let idx = 5
      let file_size = parts[idx]
      if (file_size === '|') {
        idx++
        file_size = parts[idx]
      }
      if (file_size === '~') {
        idx++
        file_size = parts[idx]
      }
      return { id, ext, resolution, fps, file_size }
    })
    .filter(format => format.file_size && format.ext !== 'mhtml')
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
}

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
            <th>fps</th>
            <th>file size</th>
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
              <td>
                <Link href={'/download/' + video_id + '/' + format.id}>
                  <button>Download</button>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    child.on('exit', async exit_code => {
      console.log('download ended:', { video_id, exit_code })
      if (exit_code !== 0) return

      let files = await pfs.readdir(downloadDir)
      let filename = files.find(f => f.includes(video_id))
      if (!filename) return

      let node = DownloadVideo({ video_id, detail, filename })

      sessions.forEach(session => {
        if (session.url !== currentUrl) return
        let element = nodeToVElementOptimized(node, {
          type: 'ws',
          ws: session.ws,
          url: session.url,
          session,
        })
        let message: ServerMessage = ['update-in', '#downloadPage', element]
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
  console.log('attrs:', attrs)
  return (
    <div id="downloadPage">
      <h2>{detail.title}</h2>
      <p>{detail.description}</p>
      {!filename ? (
        <p>loading video...</p>
      ) : (
        <>
          <p>Video ready.</p>
          <p>
            Download{' '}
            <a href={'/downloads/' + filename} download={filename}>
              {filename}
            </a>
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
