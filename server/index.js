const config = require('../shared/config')
const logger = require('../shared/logger')
const mongo = require('../shared/mongo')
const nsqWriter = require('../shared/nsqWriter')
const workerResponder = require('./workerResponder')
const clean = require('../clean')

;(async() => {
  try {
    await require('../install').install()
    await mongo.connect(config.mongodb.url, config.mongodb.database, config.mongodb.serverOptions)
    await clean.setupCron()
    await nsqWriter.connect()
    workerResponder.connect()
    await main()
  } catch (e) {
    logger.error(e)
    await closeConnections()
    process.exitCode = 1
  }
})()

async function closeConnections() {
  await clean.stopCron()
  await mongo.close()
  await nsqWriter.close()
  await workerResponder.close()
}

async function main() {
  const RESTError = require('../shared/RESTError')
  const getSiteConfig = require('../shared/getSiteConfig')
  const Koa = require('koa')
  const Router = require('koa-router')
  const mount = require('koa-mount')
  const serve = require('koa-static')
  const send = require('koa-send')
  const path = require('path')
  const render = require('./render')
  const sitemap = require('./sitemap')
  const stoppable = require('stoppable')
  const parseForwardedHeader = require('forwarded-parse')

  const app = new Koa()

  app.on('error', e => {
    // 'ERR_STREAM_DESTROYED' normally because the client closed the connection
    if (e.code === 'ERR_STREAM_DESTROYED') {
      logger.debug(e)
    } else {
      logger.error(e)
    }
  })

  app.use(async(ctx, next) => {
    try {
      logger.debug(ctx.method, ctx.href)
      await next()
      logger.log(`${ctx.method} ${ctx.href} ${ctx.status}`)
    } catch (e) {
      let err = e
      if (!(e instanceof RESTError)) {
        const { timestamp, eventId } = logger.error(e)
        err = new RESTError('SERVER_INTERNAL_ERROR', timestamp, eventId)
      }
      ctx.set('Kasha-Code', err.code)
      ctx.status = err.httpStatus
      ctx.body = err.toJSON()
      logger.log(`${ctx.method} ${ctx.href} ${ctx.status}: ${err.code}`)
    }
  })

  // proxy routes
  const proxyRoutes = new Router()
    .get('/sitemap.:page(\\d+).xml', sitemap.sitemap)
    .get('/sitemap.google.:page(\\d+).xml', sitemap.googleSitemap)
    .get('/sitemap.google.news.:page(\\d+).xml', sitemap.googleNewsSitemap)
    .get('/sitemap.google.image.:page(\\d+).xml', sitemap.googleImageSitemap)
    .get('/sitemap.google.video.:page(\\d+).xml', sitemap.googleVideoSitemap)
    .get('/sitemap.debug/:path*', sitemap.googleSitemapItem)
    .get('/sitemap.index.:page(\\d+).xml', sitemap.sitemapIndex)
    .get('/sitemap.index.google.:page(\\d+).xml', sitemap.googleSitemapIndex)
    .get('/sitemap.index.google.news.:page(\\d+).xml', sitemap.googleNewsSitemapIndex)
    .get('/sitemap.index.google.image.:page(\\d+).xml', sitemap.googleImageSitemapIndex)
    .get('/sitemap.index.google.video.:page(\\d+).xml', sitemap.googleVideoSitemapIndex)
    .get('/robots.txt', sitemap.robotsTxt)
    .get('(.*)', ctx => {
      ctx.query = {
        url: ctx.siteConfig.protocol + '://' + ctx.siteConfig.host + ctx.url,
        deviceType: ctx.siteConfig.deviceType || 'desktop',
        type: 'html'
      }
      ctx.path = '/render'
      return render(ctx)
    })
    .routes()


  // api routes
  const siteParam = ':site(https?://[^/]+)'
  const apiRouter = new Router()

  if (config.enableHomepage) {
    apiRouter.get('/', async ctx => {
      await send(ctx, 'index.html', { root: path.resolve(__dirname, '../static') })
    })
    apiRouter.use(mount('/static', serve(path.resolve(__dirname, '../static'))))
  }

  const apiRoutes = apiRouter
    .param('site', async(site, ctx, next) => {
      try {
        const url = new URL(site)
        ctx.site = url.origin
        ctx.siteConfig = await getSiteConfig({ host: url.host, protocol: url.protocol.slice(0, -1) })
        return next()
      } catch (e) {
        throw new RESTError('CLIENT_INVALID_PARAM', 'site')
      }
    })
    .get(`/${siteParam}/sitemap.:page(\\d+).xml`, sitemap.sitemap)
    .get(`/${siteParam}/sitemap.google.:page(\\d+).xml`, sitemap.googleSitemap)
    .get(`/${siteParam}/sitemap.google.news.:page(\\d+).xml`, sitemap.googleNewsSitemap)
    .get(`/${siteParam}/sitemap.google.image.:page(\\d+).xml`, sitemap.googleImageSitemap)
    .get(`/${siteParam}/sitemap.google.video.:page(\\d+).xml`, sitemap.googleVideoSitemap)
    .get(`/${siteParam}/sitemap.debug/:path*`, sitemap.googleSitemapItem)
    .get(`/${siteParam}/sitemap.index.:page(\\d+).xml`, sitemap.sitemapIndex)
    .get(`/${siteParam}/sitemap.index.google.:page(\\d+).xml`, sitemap.googleSitemapIndex)
    .get(`/${siteParam}/sitemap.index.google.news.:page(\\d+).xml`, sitemap.googleNewsSitemapIndex)
    .get(`/${siteParam}/sitemap.index.google.image.:page(\\d+).xml`, sitemap.googleImageSitemapIndex)
    .get(`/${siteParam}/sitemap.index.google.video.:page(\\d+).xml`, sitemap.googleVideoSitemapIndex)
    .get(`/${siteParam}/robots.txt`, sitemap.robotsTxt)
    .get('/render', render)
    .get('/cache', (ctx, next) => {
      ctx.query.noWait = ''
      return next()
    }, render)
    .get('/(http.+)', (ctx, next) => {
      ctx.query = {
        url: ctx.url.slice(1),
        deviceType: ctx.headers['x-device-type'] || 'desktop',
        type: 'static'
      }
      ctx.path = '/render'
      return next()
    }, render)
    .get('(.*)', () => {
      throw new RESTError('CLIENT_NO_SUCH_API')
    })
    .routes()

  app.use(async(ctx, next) => {
    if (ctx.method === 'HEAD') {
      // health check request
      ctx.status = 200
      return
    } else if (ctx.method !== 'GET') {
      throw new RESTError('CLIENT_METHOD_NOT_ALLOWED', ctx.method)
    }

    let host = ctx.host
    let protocol

    if (host && config.apiHost && config.apiHost.includes(host)) {
      ctx.mode = 'api'
      return apiRoutes(ctx, next)
    } else {
      if (ctx.headers.forwarded) {
        try {
          const forwarded = parseForwardedHeader(ctx.headers.forwarded)[0]
          if (forwarded.host) {
            host = forwarded.host
          }

          if (forwarded.proto) {
            protocol = forwarded.proto
          }
        } catch (e) {
          throw new RESTError('CLIENT_INVALID_HEADER', 'Forwarded')
        }
      } else if (ctx.headers['x-forwarded-host']) {
        host = ctx.headers['x-forwarded-host']
      }

      if (!protocol && ctx.headers['x-forwarded-proto']) {
        protocol = ctx.headers['x-forwarded-proto']
      }

      if (protocol && !['http', 'https'].includes(protocol)) {
        throw new RESTError('CLIENT_INVALID_PROTOCOL')
      }

      if (!host) {
        throw new RESTError('CLIENT_EMPTY_HOST_HEADER')
      }

      ctx.siteConfig = await getSiteConfig(host)

      if (!ctx.siteConfig) {
        throw new RESTError('CLIENT_HOST_CONFIG_NOT_EXIST')
      }

      ctx.mode = 'proxy'
      ctx.site = (protocol || ctx.siteConfig.defaultProtocol) + '://' + ctx.siteConfig.host
      return proxyRoutes(ctx, next)
    }
  })

  const server = stoppable(app.listen(config.port))

  // graceful exit
  let stopping = false
  async function exit() {
    if (stopping) return

    stopping = true
    logger.info('Closing the server. Please wait for finishing the pending requests...')

    server.stop(async() => {
      await closeConnections()
      logger.info('exit successfully')
    })
  }

  process.on('SIGINT', exit)
  process.on('SIGTERM', exit)

  logger.info(`Kasha http server started at port ${config.port}`)
}
