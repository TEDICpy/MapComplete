import LayoutConfig from "../../Models/ThemeConfig/LayoutConfig";
import FilteringFeatureSource from "./Sources/FilteringFeatureSource";
import PerLayerFeatureSourceSplitter from "./PerLayerFeatureSourceSplitter";
import FeatureSource, {FeatureSourceForLayer, IndexedFeatureSource, Tiled} from "./FeatureSource";
import TiledFeatureSource from "./TiledFeatureSource/TiledFeatureSource";
import {UIEventSource} from "../UIEventSource";
import {TileHierarchyTools} from "./TiledFeatureSource/TileHierarchy";
import FilteredLayer from "../../Models/FilteredLayer";
import MetaTagging from "../MetaTagging";
import RememberingSource from "./Sources/RememberingSource";
import OverpassFeatureSource from "../Actors/OverpassFeatureSource";
import {Changes} from "../Osm/Changes";
import GeoJsonSource from "./Sources/GeoJsonSource";
import Loc from "../../Models/Loc";
import WayHandlingApplyingFeatureSource from "./Sources/WayHandlingApplyingFeatureSource";
import RegisteringAllFromFeatureSourceActor from "./Actors/RegisteringAllFromFeatureSourceActor";
import TiledFromLocalStorageSource from "./TiledFeatureSource/TiledFromLocalStorageSource";
import SaveTileToLocalStorageActor from "./Actors/SaveTileToLocalStorageActor";
import DynamicGeoJsonTileSource from "./TiledFeatureSource/DynamicGeoJsonTileSource";
import {TileHierarchyMerger} from "./TiledFeatureSource/TileHierarchyMerger";
import RelationsTracker from "../Osm/RelationsTracker";
import {NewGeometryFromChangesFeatureSource} from "./Sources/NewGeometryFromChangesFeatureSource";
import ChangeGeometryApplicator from "./Sources/ChangeGeometryApplicator";
import {BBox} from "../BBox";
import OsmFeatureSource from "./TiledFeatureSource/OsmFeatureSource";
import {OsmConnection} from "../Osm/OsmConnection";
import {Tiles} from "../../Models/TileRange";
import TileFreshnessCalculator from "./TileFreshnessCalculator";


export default class FeaturePipeline {

    public readonly sufficientlyZoomed: UIEventSource<boolean>;

    public readonly runningQuery: UIEventSource<boolean>;
    public readonly timeout: UIEventSource<number>;

    public readonly somethingLoaded: UIEventSource<boolean> = new UIEventSource<boolean>(false)
    public readonly newDataLoadedSignal: UIEventSource<FeatureSource> = new UIEventSource<FeatureSource>(undefined)

    private readonly overpassUpdater: OverpassFeatureSource
    private state: {
        readonly filteredLayers: UIEventSource<FilteredLayer[]>,
        readonly locationControl: UIEventSource<Loc>,
        readonly selectedElement: UIEventSource<any>,
        readonly changes: Changes,
        readonly layoutToUse: LayoutConfig,
        readonly leafletMap: any,
        readonly overpassUrl: UIEventSource<string[]>;
        readonly overpassTimeout: UIEventSource<number>;
        readonly overpassMaxZoom: UIEventSource<number>;
        readonly osmConnection: OsmConnection
        readonly currentBounds: UIEventSource<BBox>
    };
    private readonly relationTracker: RelationsTracker
    private readonly perLayerHierarchy: Map<string, TileHierarchyMerger>;

    private readonly freshnesses = new Map<string, TileFreshnessCalculator>();

    private readonly oldestAllowedDate: Date = new Date(new Date().getTime() - 60 * 60 * 24 * 30 * 1000);
    private readonly osmSourceZoomLevel = 14

    constructor(
        handleFeatureSource: (source: FeatureSourceForLayer & Tiled) => void,
        state: {
            readonly filteredLayers: UIEventSource<FilteredLayer[]>,
            readonly locationControl: UIEventSource<Loc>,
            readonly selectedElement: UIEventSource<any>,
            readonly changes: Changes,
            readonly layoutToUse: LayoutConfig,
            readonly leafletMap: any,
            readonly overpassUrl: UIEventSource<string[]>;
            readonly overpassTimeout: UIEventSource<number>;
            readonly overpassMaxZoom: UIEventSource<number>;
            readonly osmConnection: OsmConnection
            readonly currentBounds: UIEventSource<BBox>
        }) {
        this.state = state;

        const self = this
        // milliseconds
        const useOsmApi = state.locationControl.map(l => l.zoom > (state.overpassMaxZoom.data ?? 12))
        this.relationTracker = new RelationsTracker()


        this.sufficientlyZoomed = state.locationControl.map(location => {
                if (location?.zoom === undefined) {
                    return false;
                }
                let minzoom = Math.min(...state.layoutToUse.layers.map(layer => layer.minzoom ?? 18));
                return location.zoom >= minzoom;
            }
        );

        const neededTilesFromOsm = this.getNeededTilesFromOsm(this.sufficientlyZoomed)

        const perLayerHierarchy = new Map<string, TileHierarchyMerger>()
        this.perLayerHierarchy = perLayerHierarchy

        const patchedHandleFeatureSource = function (src: FeatureSourceForLayer & IndexedFeatureSource & Tiled) {
            // This will already contain the merged features for this tile. In other words, this will only be triggered once for every tile
            const srcFiltered =
                new FilteringFeatureSource(state, src.tileIndex,
                    new WayHandlingApplyingFeatureSource(
                        new ChangeGeometryApplicator(src, state.changes)
                    )
                )

            handleFeatureSource(srcFiltered)
            self.somethingLoaded.setData(true)
            self.freshnesses.get(src.layer.layerDef.id).addTileLoad(src.tileIndex, new Date())
        };


        for (const filteredLayer of state.filteredLayers.data) {
            const id = filteredLayer.layerDef.id
            const source = filteredLayer.layerDef.source

            const hierarchy = new TileHierarchyMerger(filteredLayer, (tile, _) => patchedHandleFeatureSource(tile))
            perLayerHierarchy.set(id, hierarchy)

            this.freshnesses.set(id, new TileFreshnessCalculator())

            if (source.geojsonSource === undefined) {
                // This is an OSM layer
                // We load the cached values and register them
                // Getting data from upstream happens a bit lower
                new TiledFromLocalStorageSource(filteredLayer,
                    (src) => {
                        new RegisteringAllFromFeatureSourceActor(src)
                        hierarchy.registerTile(src);
                        src.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(src))
                    }, state)

                TiledFromLocalStorageSource.GetFreshnesses(id).forEach((value, key) => {
                    self.freshnesses.get(id).addTileLoad(key, value)
                })

                continue
            }

            if (source.geojsonZoomLevel === undefined) {
                // This is a 'load everything at once' geojson layer
                // We split them up into tiles anyway
                const src = new GeoJsonSource(filteredLayer)
                TiledFeatureSource.createHierarchy(src, {
                    layer: src.layer,
                    minZoomLevel: 14,
                    dontEnforceMinZoom: true,
                    registerTile: (tile) => {
                        new RegisteringAllFromFeatureSourceActor(tile)
                        perLayerHierarchy.get(id).registerTile(tile)
                        tile.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(tile))
                    }
                })
            } else {
                new DynamicGeoJsonTileSource(
                    filteredLayer,
                    tile => {
                        new RegisteringAllFromFeatureSourceActor(tile)
                        perLayerHierarchy.get(id).registerTile(tile)
                        tile.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(tile))
                    },
                    state
                )
            }
        }


        const osmFeatureSource = new OsmFeatureSource({
            isActive: useOsmApi,
            neededTiles: neededTilesFromOsm,
            handleTile: tile => {
                new RegisteringAllFromFeatureSourceActor(tile)
                new SaveTileToLocalStorageActor(tile, tile.tileIndex)
                perLayerHierarchy.get(tile.layer.layerDef.id).registerTile(tile)
                tile.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(tile))

            },
            state: state,
            markTileVisited: (tileId) =>
                state.filteredLayers.data.forEach(flayer => {
                    SaveTileToLocalStorageActor.MarkVisited(flayer.layerDef.id, tileId, new Date())
                })
        })


        const updater = this.initOverpassUpdater(state, useOsmApi)
        this.overpassUpdater = updater;
        this.timeout = updater.timeout

        // Actually load data from the overpass source
        new PerLayerFeatureSourceSplitter(state.filteredLayers,
            (source) => TiledFeatureSource.createHierarchy(source, {
                layer: source.layer,
                minZoomLevel: 14,
                dontEnforceMinZoom: true,
                maxFeatureCount: state.layoutToUse.clustering.minNeededElements,
                maxZoomLevel: state.layoutToUse.clustering.maxZoom,
                registerTile: (tile) => {
                    // We save the tile data for the given layer to local storage
                    new SaveTileToLocalStorageActor(tile, tile.tileIndex)
                    perLayerHierarchy.get(source.layer.layerDef.id).registerTile(new RememberingSource(tile))
                    tile.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(tile))

                }
            }),
            updater)


        // Also load points/lines that are newly added. 
        const newGeometry = new NewGeometryFromChangesFeatureSource(state.changes)
        new RegisteringAllFromFeatureSourceActor(newGeometry)
        // A NewGeometryFromChangesFeatureSource does not split per layer, so we do this next
        new PerLayerFeatureSourceSplitter(state.filteredLayers,
            (perLayer) => {
                // We don't bother to split them over tiles as it'll contain little features by default, so we simply add them like this
                perLayerHierarchy.get(perLayer.layer.layerDef.id).registerTile(perLayer)
                // AT last, we always apply the metatags whenever possible
                perLayer.features.addCallbackAndRunD(_ => self.applyMetaTags(perLayer))
                perLayer.features.addCallbackAndRunD(_ => self.newDataLoadedSignal.setData(perLayer))

            },
            newGeometry
        )


        // Whenever fresh data comes in, we need to update the metatagging
        self.newDataLoadedSignal.stabilized(1000).addCallback(src => {
            self.updateAllMetaTagging()
        })


        this.runningQuery = updater.runningQuery.map(
            overpass => overpass || osmFeatureSource.isRunning.data, [osmFeatureSource.isRunning]
        )


    }

    private freshnessForVisibleLayers(z: number, x: number, y: number): Date {
        let oldestDate = undefined;
        for (const flayer of this.state.filteredLayers.data) {
            if (!flayer.isDisplayed.data) {
                continue
            }
            if (this.state.locationControl.data.zoom < flayer.layerDef.minzoom) {
                continue;
            }
            const freshness = this.freshnesses.get(flayer.layerDef.id).freshnessFor(z, x, y)
            if (freshness === undefined) {
                // SOmething is undefined --> we return undefined as we have to download
                return undefined
            }
            if (oldestDate === undefined || oldestDate > freshness) {
                oldestDate = freshness
            }
        }
        return oldestDate
    }

    private getNeededTilesFromOsm(isSufficientlyZoomed: UIEventSource<boolean>): UIEventSource<number[]> {
        const self = this
        return this.state.currentBounds.map(bbox => {
            if (bbox === undefined) {
                return
            }
            if (!isSufficientlyZoomed.data) {
                return;
            }
            const osmSourceZoomLevel = self.osmSourceZoomLevel
            const range = bbox.containingTileRange(osmSourceZoomLevel)
            const tileIndexes = []
            if (range.total > 100) {
                // Too much tiles!
                return []
            }
            Tiles.MapRange(range, (x, y) => {
                const i = Tiles.tile_index(osmSourceZoomLevel, x, y);
                const oldestDate = self.freshnessForVisibleLayers(osmSourceZoomLevel, x, y)
                if (oldestDate !== undefined && oldestDate > this.oldestAllowedDate) {
                    console.debug("Skipping tile", osmSourceZoomLevel, x, y, "as a decently fresh one is available")
                    // The cached tiles contain decently fresh data
                    return;
                }
                tileIndexes.push(i)
            })
            return tileIndexes
        })
    }

    private initOverpassUpdater(state: {
        layoutToUse: LayoutConfig,
        currentBounds: UIEventSource<BBox>,
        locationControl: UIEventSource<Loc>,
        readonly overpassUrl: UIEventSource<string[]>;
        readonly overpassTimeout: UIEventSource<number>;
        readonly overpassMaxZoom: UIEventSource<number>,
    }, useOsmApi: UIEventSource<boolean>): OverpassFeatureSource {
        const minzoom = Math.min(...state.layoutToUse.layers.map(layer => layer.minzoom))
        const allUpToDateAndZoomSufficient = state.currentBounds.map(bbox => {
            if (bbox === undefined) {
                return true
            }
            if (!this.sufficientlyZoomed?.data) {
                return true;
            }
            let zoom = state.locationControl.data.zoom
            if (zoom < minzoom) {
                return true;
            }
            if (zoom > 16) {
                zoom = 16
            }
            if (zoom < 8) {
                zoom = zoom + 2
            }
            const range = bbox.containingTileRange(zoom)
            const self = this;
            const allFreshnesses = Tiles.MapRange(range, (x, y) => self.freshnessForVisibleLayers(zoom, x, y))
            return !allFreshnesses.some(freshness => freshness === undefined || freshness < this.oldestAllowedDate)

        }, [state.locationControl])

        allUpToDateAndZoomSufficient.addCallbackAndRunD(allUpToDate => console.log("All up to data is: ", allUpToDate))
        const self = this;
        const updater = new OverpassFeatureSource(state,
            {
                relationTracker: this.relationTracker,
                isActive: useOsmApi.map(b => !b && !allUpToDateAndZoomSufficient.data, [allUpToDateAndZoomSufficient]),
                onBboxLoaded: ((bbox, date, downloadedLayers) => {
                    Tiles.MapRange(bbox.containingTileRange(self.osmSourceZoomLevel), (x, y) => {
                        downloadedLayers.forEach(layer => {
                            SaveTileToLocalStorageActor.MarkVisited(layer.id, Tiles.tile_index(this.osmSourceZoomLevel, x, y), date)
                        })
                    })

                })
            });


        // Register everything in the state' 'AllElements'
        new RegisteringAllFromFeatureSourceActor(updater)
        return updater;
    }

    private applyMetaTags(src: FeatureSourceForLayer) {
        const self = this
        console.debug("Applying metatagging onto ", src.name)
        window.setTimeout(
            () => {
                MetaTagging.addMetatags(
                    src.features.data,
                    {
                        memberships: this.relationTracker,
                        getFeaturesWithin: (layerId, bbox: BBox) => self.GetFeaturesWithin(layerId, bbox)
                    },
                    src.layer.layerDef,
                    {
                        includeDates: true,
                        // We assume that the non-dated metatags are already set by the cache generator
                        includeNonDates: !src.layer.layerDef.source.isOsmCacheLayer
                    }
                )
            },
            15
        )

    }

    private updateAllMetaTagging() {
        const self = this;
        console.log("Reupdating all metatagging")
        this.perLayerHierarchy.forEach(hierarchy => {
            hierarchy.loadedTiles.forEach(src => {
                self.applyMetaTags(src)
            })
        })

    }

    public GetAllFeaturesWithin(bbox: BBox): any[][] {
        const self = this
        const tiles = []
        Array.from(this.perLayerHierarchy.keys())
            .forEach(key => tiles.push(...self.GetFeaturesWithin(key, bbox)))
        return tiles;
    }

    public GetFeaturesWithin(layerId: string, bbox: BBox): any[][] {
        const requestedHierarchy = this.perLayerHierarchy.get(layerId)
        if (requestedHierarchy === undefined) {
            console.warn("Layer ", layerId, "is not defined. Try one of ", Array.from(this.perLayerHierarchy.keys()))
            return undefined;
        }
        return TileHierarchyTools.getTiles(requestedHierarchy, bbox)
            .filter(featureSource => featureSource.features?.data !== undefined)
            .map(featureSource => featureSource.features.data.map(fs => fs.feature))
    }

    public GetTilesPerLayerWithin(bbox: BBox, handleTile: (tile: FeatureSourceForLayer & Tiled) => void) {
        Array.from(this.perLayerHierarchy.values()).forEach(hierarchy => {
            TileHierarchyTools.getTiles(hierarchy, bbox).forEach(handleTile)
        })
    }

}