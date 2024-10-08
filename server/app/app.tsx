import { o } from './jsx/jsx.js'
import { scanTemplateDir } from '../template.js'
import express, { Response } from 'express'
import type { Context, ExpressContext, WsContext } from './context'
import type { Element, Node } from './jsx/types'
import { writeNode } from './jsx/html.js'
import { sendHTMLHeader } from './express.js'
import { OnWsMessage } from '../ws/wss.js'
import { dispatchUpdate } from './jsx/dispatch.js'
import { EarlyTerminate } from './helpers.js'
import { getWSSession } from './session.js'
import DemoCookieSession from './pages/demo-cookie-session.js'
import escapeHtml from 'escape-html'
import { Flush } from './components/flush.js'
import { config } from '../config.js'
import Stats from './stats.js'
import { MuteConsole } from './components/script.js'
import { matchRoute, PageRouteMatch } from './routes.js'
import { topMenu } from './components/top-menu.js'
import { redirectDict } from './routes.js'
import type { ClientMountMessage, ClientRouteMessage } from '../../client/types'
import { then } from '@beenotung/tslib/result.js'
import { style } from './app-style.js'
import { renderIndexTemplate } from '../../template/index.js'
import escapeHTML from 'escape-html'
import { HTMLStream } from './jsx/stream.js'
import home from './pages/home.js'

if (config.development) {
  scanTemplateDir('template')
}
function renderTemplate(
  stream: HTMLStream,
  context: Context,
  options: { title: string; description: string; app: Node },
) {
  const app = options.app
  renderIndexTemplate(stream, {
    title: escapeHTML(options.title),
    description: escapeHTML(options.description),
    app:
      typeof app == 'string' ? app : stream => writeNode(stream, app, context),
  })
}

let scripts = config.development ? (
  <script src="/js/index.js" type="module" defer></script>
) : (
  <>
    {MuteConsole}
    <script src="/js/bundle.min.js" type="module" defer></script>
  </>
)

export function App(main: Node): Element {
  // you can write the AST direct for more compact wire-format
  return [
    'div.app',
    {},
    [
      // or you can write in JSX for better developer-experience (if you're coming from React)
      <>
        {style}
        <h1 class="title">
          swarm-web <a href="https://github.com/beenotung/swarm-web">git</a>
        </h1>
        {scripts}
        <Stats />
        {topMenu}
        <fieldset>{main}</fieldset>
        <Flush />
      </>,
    ],
  ]
}

export let appRouter = express.Router()

// non-streaming routes
appRouter.use('/cookie-session/token', DemoCookieSession.tokenHandler)
appRouter.use(home.middleware)
Object.entries(redirectDict).forEach(([from, to]) =>
  appRouter.use(from, (_req, res) => res.redirect(to)),
)

// html-streaming routes
appRouter.use((req, res, next) => {
  sendHTMLHeader(res)

  let context: ExpressContext = {
    type: 'express',
    req,
    res,
    next,
    url: req.url,
  }

  then(matchRoute(context), route => {
    if (route.status) {
      res.status(route.status)
    }

    route.description = route.description.replace(/"/g, "'")

    if (route.streaming === false) {
      responseHTML(res, context, route)
    } else {
      streamHTML(res, context, route)
    }
  })
})

function responseHTML(
  res: Response,
  context: ExpressContext,
  route: PageRouteMatch,
) {
  let html = ''
  let stream = {
    write(chunk: string) {
      html += chunk
    },
    flush() {},
  }

  try {
    renderTemplate(stream, context, {
      title: route.title || config.site_name,
      description: route.description || config.site_description,
      app: App(route.node),
    })
  } catch (error) {
    if (error === EarlyTerminate) {
      return
    }
    console.error('Failed to render App:', error)
    if (!res.headersSent) {
      res.status(500)
    }
    html +=
      error instanceof Error
        ? 'Internal Error: ' + escapeHtml(error.message)
        : 'Unknown Error: ' + escapeHtml(String(error))
  }

  // deepcode ignore XSS: the dynamic content is html-escaped
  res.end(html)
}

function streamHTML(
  res: Response,
  context: ExpressContext,
  route: PageRouteMatch,
) {
  try {
    renderTemplate(res, context, {
      title: route.title || config.site_name,
      description: route.description || config.site_description,
      app: App(route.node),
    })
    res.end()
  } catch (error) {
    if (error === EarlyTerminate) {
      return
    }
    console.error('Failed to render App:', error)
    if (!res.headersSent) {
      res.status(500)
    }
    // deepcode ignore XSS: the dynamic content is html-escaped
    res.end(
      error instanceof Error
        ? 'Internal Error: ' + escapeHtml(error.message)
        : 'Unknown Error: ' + escapeHtml(String(error)),
    )
  }
}

export let onWsMessage: OnWsMessage = (event, ws, _wss) => {
  console.log('ws message:', event)
  // TODO handle case where event[0] is not url
  let eventType: string | undefined
  let url: string
  let args: unknown[] | undefined
  let session = getWSSession(ws)
  if (event[0] === 'mount') {
    event = event as ClientMountMessage
    eventType = 'mount'
    url = event[1]
    session.locales = event[2]
    let timeZone = event[3]
    if (timeZone && timeZone !== 'null') {
      session.timeZone = timeZone
    }
    session.timezoneOffset = event[4]
  } else if (event[0][0] === '/') {
    event = event as ClientRouteMessage
    eventType = 'route'
    url = event[0]
    args = event.slice(1)
  } else {
    console.log('unknown type of ws message:', event)
    return
  }
  session.url = url
  let context: WsContext = {
    type: 'ws',
    ws,
    url,
    args,
    event: eventType,
    session,
  }
  then(matchRoute(context), route => {
    let node = App(route.node)
    dispatchUpdate(context, node, route.title)
  })
}
