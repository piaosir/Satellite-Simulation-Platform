import { createApp } from 'vue'
import SunOutageApp from './suntool/SunOutageApp.vue'
import './styles/global.css'
import './stores/theme'
import './shared/i18n/runtime'

createApp(SunOutageApp).mount('#app')
