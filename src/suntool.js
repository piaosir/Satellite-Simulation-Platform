import { createApp } from 'vue'
import SunOutageApp from './suntool/SunOutageApp.vue'
import './styles/global.css'
import './shared/ui/controls'
import './stores/theme'
import './stores/uiFont'
import './shared/i18n/runtime'

createApp(SunOutageApp).mount('#app')
