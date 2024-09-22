import JSZip from "jszip";
import {saveAs} from "file-saver";
import {format} from 'date-fns';
import {downloadArticleHTMLs, packHTMLAssets} from "~/utils";
import {uploadProxy} from "~/store/proxy";
import type {DownloadableArticle} from "~/types/types";


/**
 * 批量下载缓存文章
 * @param articles
 * @param filename
 */
export function useBatchDownload() {
    const loading = ref(false)
    const phase = ref()
    const downloadedCount = ref(0)
    const packedCount = ref(0)

    async function download(articles: DownloadableArticle[], filename: string) {
        loading.value = true

        phase.value = '下载文章内容'
        const results = await downloadArticleHTMLs(articles, (count: number) => {
            downloadedCount.value = count
        })

        phase.value = '打包'
        const zip = new JSZip()
        for (const article of results) {
            try {
                await packHTMLAssets(article.html!, article.title.replaceAll('.', '_'), zip.folder(format(new Date(article.date * 1000), 'yyyy-MM-dd') + ' ' + article.title.replace(/\//g, '_'))!)
                packedCount.value++
            } catch (e: any) {
                console.info('打包失败:')
                console.warn(e.message)
            }
        }

        const blob = await zip.generateAsync({type: 'blob'})
        saveAs(blob, `${filename}.zip`)

        await uploadProxy()

        loading.value = false
    }

    return {
        loading,
        phase,
        downloadedCount,
        packedCount,
        download,
    }
}

/**
 * 批量下载合集文章
 */
export function useDownloadAlbum() {
    const loading = ref(false)
    const phase = ref()
    const downloadedCount = ref(0)
    const packedCount = ref(0)

    async function download(articles: DownloadableArticle[], filename: string) {
        loading.value = true

        phase.value = '下载文章内容'
        const results = await downloadArticleHTMLs(articles, (count: number) => {
            downloadedCount.value = count
        })

        phase.value = '打包'
        const zip = new JSZip()
        for (const article of results) {
            try {
                await packHTMLAssets(article.html!, article.title.replaceAll('.', '_'), zip.folder(format(new Date(+article.date * 1000), 'yyyy-MM-dd') + ' ' + article.title.replace(/\//g, '_'))!)
                packedCount.value++
            } catch (e: any) {
                console.info('打包失败:')
                console.warn(e.message)
            }
        }

        const blob = await zip.generateAsync({type: 'blob'})
        saveAs(blob, `${filename}.zip`)

        await uploadProxy()

        loading.value = false
    }

    return {
        loading,
        phase,
        downloadedCount,
        packedCount,
        download,
    }
}
