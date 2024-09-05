import dayjs from "dayjs";
import JSZip from "jszip";
import type {
    AccountInfo,
    AppMsgEx,
    AppMsgExWithHTML,
    AppMsgPublishResponse,
    PublishInfo,
    PublishPage,
    SearchBizResponse
} from "~/types/types";
import {updateArticleCache} from "~/store/article";
import {ARTICLE_LIST_PAGE_SIZE, ACCOUNT_LIST_PAGE_SIZE} from "~/config";
import {getAssetCache, updateAssetCache} from "~/store/assetes";
import {updateAPICache} from "~/store/api";
import * as pool from '~/utils/pool'
import mime from "mime";
import {sleep} from "@antfu/utils";
import type {DownloadResult} from "~/utils/pool";


export function formatTimeStamp(timestamp: number) {
    return dayjs.unix(timestamp).format('YYYY-MM-DD HH:mm')
}

/**
 * 使用代理下载资源
 * @param url 资源地址
 * @param proxy 代理地址
 * @param timeout 超时时间(单位: 秒)，默认 30
 */
async function downloadAssetWithProxy<T extends Blob | string>(url: string, proxy: string, timeout = 30) {
    const result = await $fetch<T>(`${proxy}?url=${encodeURIComponent(url)}`, {
        retry: 0,
        timeout: timeout * 1000,
    })

    // 统计代理下载资源流量
    if (result instanceof Blob) {
        pool.pool.incrementTraffic(proxy, result.size)
    } else {
        pool.pool.incrementTraffic(proxy, new Blob([result]).size)
    }

    return result
}

async function measureExecutionTime(label: string, taskFn: () => Promise<DownloadResult | DownloadResult[]>) {
    const start = Date.now()
    const result = await taskFn()
    const end = Date.now()
    const total = (end - start) / 1000;

    pool.formatDownloadResult(label, result, total)

    return result
}

/**
 * 下载文章的 html
 * @param articleURL
 * @param title
 */
export async function downloadArticleHTML(articleURL: string, title?: string) {
    let html = ''
    const parser = new DOMParser()

    const htmlDownloadFn = async (url: string, proxy: string) => {
        const fullHTML = await downloadAssetWithProxy<string>(url, proxy)

        // 验证是否下载完整
        const document = parser.parseFromString(fullHTML, 'text/html')
        const $jsContent = document.querySelector('#js_content')
        if (!$jsContent) {
            if (title) {
                console.info(title)
            }
            throw new Error('下载失败，请重试')
        }
        html = fullHTML

        return new Blob([html]).size
    }

    await measureExecutionTime('html下载结果:', async () => {
        return await pool.downloads([articleURL], htmlDownloadFn)
    })

    if (!html) {
        throw new Error('下载html失败，请稍后重试')
    }

    return html
}

/**
 * 批量下载文章 html
 * @param articles
 */
export async function downloadArticleHTMLs(articles: AppMsgExWithHTML[]) {
    const parser = new DOMParser()

    const htmlDownloadFn = async (article: AppMsgExWithHTML, proxy: string) => {
        const fullHTML = await downloadAssetWithProxy<string>(article.link, proxy)

        // 验证是否下载完整
        const document = parser.parseFromString(fullHTML, 'text/html')
        const $jsContent = document.querySelector('#js_content')
        if (!$jsContent) {
            if (article.title) {
                console.info(article.title)
            }
            throw new Error('下载失败，请重试')
        }

        article.html = fullHTML
        await sleep(2000)

        return new Blob([fullHTML]).size
    }

    await measureExecutionTime('html下载结果:', async () => {
        return  await pool.downloads(articles, htmlDownloadFn)
    })
}

/**
 * 打包 html 中的资源
 * @param html
 * @param title
 * @param zip
 */
export async function packHTMLAssets(html: string, title: string, zip?: JSZip) {
    if (!zip) {
        zip = new JSZip();
    }

    const parser = new DOMParser()
    const document = parser.parseFromString(html, 'text/html')
    const $jsArticleContent = document.querySelector('#js_article')!

    // #js_content 默认是不可见的(通过js修改为可见)，需要移除该样式
    $jsArticleContent.querySelector('#js_content')?.removeAttribute('style')

    // 删除无用dom元素
    $jsArticleContent.querySelector('#js_tags_preview_toast')?.remove()
    $jsArticleContent.querySelector('#content_bottom_area')?.remove()
    $jsArticleContent.querySelector('#js_temp_bottom_area')?.remove()
    $jsArticleContent.querySelectorAll('script').forEach(el => {
        el.remove()
    })


    zip.folder('assets')

    // 下载所有的图片
    const imgDownloadFn = async (img: HTMLImageElement, proxy: string) => {
        const url = img.src || img.dataset.src!
        if (!url) {
            return 0
        }

        const imgData = await downloadAssetWithProxy<Blob>(url, proxy, 10)
        const uuid = new Date().getTime() + Math.random().toString()
        const ext = mime.getExtension(imgData.type)
        zip.file(`assets/${uuid}.${ext}`, imgData)

        // 改写html中的引用路径，指向本地图片文件
        img.src = `./assets/${uuid}.${ext}`

        return imgData.size
    }
    const imgs = $jsArticleContent.querySelectorAll<HTMLImageElement>('img')
    if (imgs.length > 0) {
        await measureExecutionTime('图片下载结果:', async () => {
            return await pool.downloads<HTMLImageElement>([...imgs], imgDownloadFn)
        })
    }


    // 下载背景图片 背景图片无法用选择器选中并修改，因此用正则进行匹配替换
    let pageContentHTML = $jsArticleContent.outerHTML

    // 收集所有的背景图片地址
    const bgImageURLs = new Set<string>()
    pageContentHTML.replaceAll(/((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs, (_, p1, url, p3) => {
        bgImageURLs.add(url)
        return `${p1}${url}${p3}`
    })
    if (bgImageURLs.size > 0) {
        // 下载背景图片
        const bgImgDownloadFn = async (url: string, proxy: string) => {
            const imgData = await downloadAssetWithProxy<Blob>(url, proxy, 10)
            const uuid = new Date().getTime() + Math.random().toString()
            const ext = mime.getExtension(imgData.type)

            zip.file(`assets/${uuid}.${ext}`, imgData)
            url2pathMap.set(url, `assets/${uuid}.${ext}`)
            return imgData.size
        }
        const url2pathMap = new Map<string, string>()

        await measureExecutionTime('背景图片下载结果:', async () => {
            return await pool.downloads<string>([...bgImageURLs], bgImgDownloadFn)
        })

        // 替换背景图片路径
        pageContentHTML = pageContentHTML.replaceAll(/((?:background|background-image): url\((?:&quot;)?)((?:https?|\/\/)[^)]+?)((?:&quot;)?\))/gs, (_, p1, url, p3) => {
            if (url2pathMap.has(url)) {
                const path = url2pathMap.get(url)!
                return `${p1}./${path}${p3}`
            } else {
                console.warn('背景图片丢失: ', url)
                return `${p1}${url}${p3}`
            }
        })
    }


    // 下载样式表
    const linkDownloadFn = async (link: HTMLLinkElement) => {
        const url = link.href
        let stylesheetFile: Blob | null

        // 检查缓存
        const cachedAsset = await getAssetCache(url)
        if (cachedAsset) {
            stylesheetFile = cachedAsset.file
        } else {
            const stylesheet = await $fetch<string>(url, {retryDelay: 2000})
            stylesheetFile = new Blob([stylesheet], { type: 'text/css' })
            await updateAssetCache({url: url, file: stylesheetFile})
        }

        const uuid = new Date().getTime() + Math.random().toString()
        zip.file(`assets/${uuid}.css`, stylesheetFile)
        localLinks += `<link rel="stylesheet" href="./assets/${uuid}.css">`

        return stylesheetFile.size
    }
    let localLinks: string = ''
    const links = document.querySelectorAll<HTMLLinkElement>('head link[rel="stylesheet"]')
    if (links.length > 0) {
        await measureExecutionTime('样式下载结果:', async () => {
            return await pool.downloads<HTMLLinkElement>([...links], linkDownloadFn, false)
        })
    }

    const indexHTML = `<!DOCTYPE html>
<html lang="zh_CN">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=0,viewport-fit=cover">
    <title>${title}</title>
    ${localLinks}
    <style>
        #page-content {
            max-width: 667px;
            margin: 0 auto;
        }
        img {
            max-width: 100%;
        }
    </style>
</head>
<body>
${pageContentHTML}
</body>
</html>`

    zip.file('index.html', indexHTML)

    return zip
}

const loginAccount = useLoginAccount()

/**
 * 获取文章列表
 * @param fakeid
 * @param token
 * @param begin
 * @param keyword
 */
export async function getArticleList(fakeid: string, token: string, begin = 0, keyword = ''): Promise<[AppMsgEx[], boolean, number]> {
    const resp = await $fetch<AppMsgPublishResponse>('/api/appmsgpublish', {
        method: 'GET',
        query: {
            id: fakeid,
            token: token,
            begin: begin,
            size: ARTICLE_LIST_PAGE_SIZE,
            keyword: keyword,
        },
        retry: 0,
    })

    // 记录 api 调用
    await updateAPICache({
        name: 'appmsgpublish',
        account: loginAccount.value.nick_name!,
        call_time: new Date().getTime(),
        is_normal: resp.base_resp.ret === 0 || resp.base_resp.ret === 200003,
        payload: {
            id: fakeid,
            begin: begin,
            size: ARTICLE_LIST_PAGE_SIZE,
            keyword: keyword,
        }
    })

    if (resp.base_resp.ret === 0) {
        const publish_page: PublishPage = JSON.parse(resp.publish_page)
        const publish_list = publish_page.publish_list.filter(item => !!item.publish_info)

        // 返回的文章数量与请求的文章数量不一致就说明已结束
        const isCompleted = publish_list.length !== ARTICLE_LIST_PAGE_SIZE

        // 更新缓存，注意搜索的结果不能写入缓存
        if (!keyword) {
            try {
                await updateArticleCache(publish_list, isCompleted, fakeid)
            } catch (e) {
                console.info('缓存失败')
                console.error(e)
            }
        }

        const articles = publish_list.flatMap(item => {
            const publish_info: PublishInfo = JSON.parse(item.publish_info)
            return publish_info.appmsgex
        })
        return [articles, isCompleted, publish_page.total_count]
    } else if (resp.base_resp.ret === 200003) {
        throw new Error('session expired')
    } else {
        throw new Error(`${resp.base_resp.ret}:${resp.base_resp.err_msg}`)
    }
}

/**
 * 获取公众号列表
 * @param token
 * @param begin
 * @param keyword
 */
export async function getAccountList(token: string, begin = 0, keyword = ''): Promise<[AccountInfo[], boolean]> {
    const resp = await $fetch<SearchBizResponse>('/api/searchbiz', {
        method: 'GET',
        query: {
            keyword: keyword,
            begin: begin,
            size: ACCOUNT_LIST_PAGE_SIZE,
            token: token,
        },
        retry: 0,
    })

    // 记录 api 调用
    await updateAPICache({
        name: 'searchbiz',
        account: loginAccount.value.nick_name!,
        call_time: new Date().getTime(),
        is_normal: resp.base_resp.ret === 0 || resp.base_resp.ret === 200003,
        payload: {
            begin: begin,
            size: ACCOUNT_LIST_PAGE_SIZE,
            keyword: keyword,
        }
    })

    if (resp.base_resp.ret === 0) {
        // 公众号判断是否结束的逻辑与文章不太一样
        // 当第一页的结果就少于5个则结束，否则只有当搜索结果为空才表示结束
        const isCompleted = begin === 0 ? resp.total < ACCOUNT_LIST_PAGE_SIZE : resp.total === 0

        return [resp.list, isCompleted]
    } else if (resp.base_resp.ret === 200003) {
        throw new Error('session expired')
    } else {
        throw new Error(`${resp.base_resp.ret}:${resp.base_resp.err_msg}`)
    }
}
