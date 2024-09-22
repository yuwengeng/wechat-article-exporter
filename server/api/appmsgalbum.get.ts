/**
 * 获取合集数据接口
 */

import {proxyMpRequest} from "~/server/utils";

interface AppMsgAlbumQuery {
    fakeid: string
    album_id: string
    is_reverse?: string
    count?: number
    begin_msgid?: string
    begin_itemidx?: string
}

export default defineEventHandler(async (event) => {
    const query = getQuery<AppMsgAlbumQuery>(event)
    const fakeid = query.fakeid
    const album_id = query.album_id
    const isReverse = query.is_reverse || '0'
    const begin_msgid = query.begin_msgid
    const begin_itemidx = query.begin_itemidx
    const count: number = query.count || 20


    const params: Record<string, string | number | undefined> = {
        action: 'getalbum',
        __biz: fakeid,
        album_id: album_id,
        begin_msgid: begin_msgid,
        begin_itemidx: begin_itemidx,
        count: count,
        is_reverse: isReverse,
        f: "json",
    }

    return proxyMpRequest({
        event: event,
        method: 'GET',
        endpoint: 'https://mp.weixin.qq.com/mp/appmsgalbum',
        query: params,
        parseJson: true,
    })
})
