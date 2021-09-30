import ImageProvider, {ProvidedImage} from "./ImageProvider";
import BaseUIElement from "../../UI/BaseUIElement";
import {UIEventSource} from "../UIEventSource";
import Svg from "../../Svg";
import {Utils} from "../../Utils";
import {LicenseInfo} from "./LicenseInfo";
import Constants from "../../Models/Constants";

export class Mapillary extends ImageProvider {

    defaultKeyPrefixes = ["mapillary"]
    
    public static readonly singleton = new Mapillary();

    private static readonly v4_cached_urls = new Map<string, UIEventSource<string>>();

    private constructor() {
        super();
    }

    private static ExtractKeyFromURL(value: string): {
        key: string,
        isApiv4?: boolean
    } {
        if (value.startsWith("https://a.mapillary.com")) {
            const key = value.substring(0, value.lastIndexOf("?")).substring(value.lastIndexOf("/") + 1)
            return {key: key, isApiv4: !isNaN(Number(key))};
        }
        const newApiFormat = value.match(/https?:\/\/www.mapillary.com\/app\/\?pKey=([0-9]*)/)
        if (newApiFormat !== null) {
            return {key: newApiFormat[1], isApiv4: true}
        }

        const mapview = value.match(/https?:\/\/www.mapillary.com\/map\/im\/(.*)/)
        if (mapview !== null) {
            const key = mapview[1]
            return {key: key, isApiv4: !isNaN(Number(key))};
        }


        if (value.toLowerCase().startsWith("https://www.mapillary.com/map/im/")) {
            // Extract the key of the image
            value = value.substring("https://www.mapillary.com/map/im/".length);
        }

        const matchApi = value.match(/https?:\/\/images.mapillary.com\/([^/]*)(&.*)?/)
        if (matchApi !== null) {
            return {key: matchApi[1]};
        }


        return {key: value, isApiv4: !isNaN(Number(value))};
    }

    SourceIcon(backlinkSource?: string): BaseUIElement {
        return Svg.mapillary_svg();
    }

    async ExtractUrls(key: string, value: string): Promise<Promise<ProvidedImage>[]> {
       return [this.PrepareUrlAsync(key, value)]
    }

    private async PrepareUrlAsync(key: string, value: string): Promise<ProvidedImage> {
        const keyV = Mapillary.ExtractKeyFromURL(value)
        if (!keyV.isApiv4) {
            const url = `https://images.mapillary.com/${keyV.key}/thumb-640.jpg?client_id=${Constants.mapillary_client_token_v3}`
            return {
                url: url,
                provider: this,
                key: key
            }
        } else {
            const key = keyV.key;
            const metadataUrl = 'https://graph.mapillary.com/' + key + '?fields=thumb_1024_url&&access_token=' + Constants.mapillary_client_token_v4;
            const source = new UIEventSource<string>(undefined)
            Mapillary.v4_cached_urls.set(key, source)
            const response = await Utils.downloadJson(metadataUrl)
            const url = <string> response["thumb_1024_url"];
            return {
                url: url,
                provider: this,
                key: key
            }
        }
    }
    
    protected async DownloadAttribution(url: string): Promise<LicenseInfo> {

        const keyV = Mapillary.ExtractKeyFromURL(url)
        if (keyV.isApiv4) {
            const license = new LicenseInfo()
            license.artist = "Contributor name unavailable";
            license.license = "CC BY-SA 4.0";
            // license.license = "Creative Commons Attribution-ShareAlike 4.0 International License";
            license.attributionRequired = true;
            return license

        }
        const key = keyV.key

        const metadataURL = `https://a.mapillary.com/v3/images/${key}?client_id=TXhLaWthQ1d4RUg0czVxaTVoRjFJZzowNDczNjUzNmIyNTQyYzI2`
        const data = await Utils.downloadJson(metadataURL)
        const license = new LicenseInfo();
        license.artist = data.properties?.username;
        license.licenseShortName = "CC BY-SA 4.0";
        license.license = "Creative Commons Attribution-ShareAlike 4.0 International License";
        license.attributionRequired = true;

        return license
    }
}