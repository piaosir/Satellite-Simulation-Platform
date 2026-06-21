// Cesium 资源由 vite-plugin-static-copy 复制到 ./cesium/，离线本地加载。
window.CESIUM_BASE_URL = './cesium/'

import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'

// 离线：不使用 Ion，底图用 Cesium 自带的 Natural Earth II 瓦片。
Cesium.Ion.defaultAccessToken = ''

export async function createGlobe(container) {
  const viewer = new Cesium.Viewer(container, {
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    creditContainer: document.createElement('div'),
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
      )
    )
  })
  viewer.scene.globe.enableLighting = true
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b0b10')
  return viewer
}
