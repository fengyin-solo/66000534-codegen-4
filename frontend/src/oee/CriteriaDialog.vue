<template>
  <el-dialog
    :model-value="modelValue"
    title="OEE 判定口径配置"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => !v && $emit('update:modelValue', false)"
  >
    <div class="dlg">
      <div class="profile-bar">
        <label class="f-label">口径方案</label>
        <el-select v-model="selectedId" size="small" class="profile-select" @change="onSelect">
          <el-option v-for="p in store.profiles" :key="p.id" :value="p.id" :label="p.name" />
        </el-select>
        <el-button size="small" @click="createNew">另存为新方案</el-button>
        <el-button
          size="small" type="danger" plain
          :disabled="!!current?.builtin"
          @click="onDelete"
        >删除</el-button>
      </div>

      <div class="name-row">
        <label class="f-label">方案名称</label>
        <el-input v-model="draft.name" size="small" placeholder="例如：旺季严口径" />
        <span v-if="errors.name" class="err-text">{{ errors.name }}</span>
      </div>

      <div class="metric-table">
        <div class="row head">
          <span class="col-m">指标</span>
          <span class="col-b">下限%</span>
          <span class="col-b">上限%</span>
          <span class="col-w">观察时段</span>
        </div>
        <div v-for="key in keys" :key="key" class="row" :class="{invalid: rowInvalid(key)}">
          <span class="col-m">
            <i class="dot" :style="{ background: meta[key].color }"></i>{{ meta[key].label }}
          </span>
          <span class="col-b">
            <el-input v-model.number="draft.metrics[key].lower" size="small" placeholder="0-100" />
          </span>
          <span class="col-b">
            <el-input v-model.number="draft.metrics[key].upper" size="small" placeholder="0-100" />
          </span>
          <span class="col-window">
            <input type="time" class="native-time" v-model="draft.metrics[key].windowStart" />
            <span class="dash">~</span>
            <input type="time" class="native-time" v-model="draft.metrics[key].windowEnd" />
          </span>
        </div>
        <div v-for="key in keys" :key="'e-'+key">
          <div v-if="errors[key+'.lower']" class="err-text indented">• {{ meta[key].label }}下限：{{ errors[key+'.lower'] }}</div>
          <div v-if="errors[key+'.upper']" class="err-text indented">• {{ meta[key].label }}上限：{{ errors[key+'.upper'] }}</div>
          <div v-if="errors[key+'.windowStart']" class="err-text indented">• {{ meta[key].label }}时段：{{ errors[key+'.windowStart'] }}</div>
          <div v-if="errors[key+'.windowEnd'] && !errors[key+'.windowStart']" class="err-text indented">• {{ meta[key].label }}时段：{{ errors[key+'.windowEnd'] }}</div>
        </div>
      </div>

      <div class="rules-note">
        校验规则：上下限均为 0-100 的百分数，且下限 ≤ 上限；时段必须填写（HH:mm，00:00-23:59），
        起始需严格早于结束。任一项不满足均不允许保存。
      </div>

      <div v-if="saveMsg" class="save-msg ok">{{ saveMsg }}</div>
    </div>

    <template #footer>
      <el-button @click="$emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :disabled="!validation.ok" @click="onSave">
        保存并生效
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MetricKey, MetricCriteria, OEECriteriaProfile } from '@/types'
import { OEE_METRIC_KEYS, OEE_METRIC_META, normalizeBound, validateProfile } from '@/oee/engine'
import { useOEEStore } from '@/oee/criteria'

const props = defineProps<{ modelValue: boolean }>()
defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const store = useOEEStore()
const keys = OEE_METRIC_KEYS
const meta = OEE_METRIC_META

const selectedId = ref(store.activeId)
const saveMsg = ref('')

function cloneMetric(c: MetricCriteria): MetricCriteria {
  return { lower: c.lower, upper: c.upper, windowStart: c.windowStart, windowEnd: c.windowEnd }
}
function cloneProfile(p: OEECriteriaProfile): OEECriteriaProfile {
  return { id: p.id, name: p.name, builtin: p.builtin, metrics: {
    availability: cloneMetric(p.metrics.availability),
    performance: cloneMetric(p.metrics.performance),
    quality: cloneMetric(p.metrics.quality),
  } }
}

const draft = reactive<OEECriteriaProfile>(cloneProfile(store.activeProfile))

const current = computed(() => store.profiles.find(p => p.id === selectedId.value))

const validation = computed(() => validateProfile(draft))
const errors = computed(() => validation.value.errors)

function rowInvalid(key: MetricKey) {
  const e = errors.value
  return e[`${key}.lower`] || e[`${key}.upper`]
    || e[`${key}.windowStart`] || e[`${key}.windowEnd`]
}

function onSelect(id: string) {
  const p = store.profiles.find(x => x.id === id)
  if (!p) return
  Object.assign(draft, cloneProfile(p))
  saveMsg.value = ''
}

function createNew() {
  const id = 'custom-' + Date.now()
  const p: OEECriteriaProfile = {
    id, name: draft.name ? draft.name + '（副本）' : '自定义口径',
    metrics: {
      availability: cloneMetric(draft.metrics.availability),
      performance: cloneMetric(draft.metrics.performance),
      quality: cloneMetric(draft.metrics.quality),
    },
  }
  Object.assign(draft, p)
  selectedId.value = id
  saveMsg.value = ''
}

async function onDelete() {
  if (!current.value || current.value.builtin) return
  try {
    await ElMessageBox.confirm(`确定删除口径「${current.value.name}」？`, '删除口径', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
    })
    store.removeProfile(current.value.id)
    selectedId.value = store.activeId
    Object.assign(draft, cloneProfile(store.activeProfile))
    ElMessage.success('已删除')
  } catch { /* 取消 */ }
}

function onSave() {
  const v = validateProfile(draft)
  if (!v.ok) return // 保存按钮本身已禁用，双保险

  const metrics = {
    availability: normalizeMetric(draft.metrics.availability),
    performance: normalizeMetric(draft.metrics.performance),
    quality: normalizeMetric(draft.metrics.quality),
  }

  // 内置口径不允许覆盖：编辑内置方案时另存为自定义副本
  let id = draft.id
  let name = draft.name.trim()
  if (draft.builtin) {
    id = 'custom-' + Date.now()
    name = name + '（自定义）'
  }

  store.upsertProfile({ id, name, metrics })
  selectedId.value = id
  draft.id = id
  draft.name = name
  delete draft.builtin
  saveMsg.value = `已保存并于 ${new Date().toLocaleTimeString()} 生效，全部图表已按该口径重算`
  ElMessage.success('口径已保存并生效')
}

function normalizeMetric(c: MetricCriteria): MetricCriteria {
  return {
    lower: normalizeBound(c.lower),
    upper: normalizeBound(c.upper),
    windowStart: c.windowStart,
    windowEnd: c.windowEnd,
  }
}

watch(() => props.modelValue, (open) => {
  if (open) {
    selectedId.value = store.activeId
    Object.assign(draft, cloneProfile(store.activeProfile))
    saveMsg.value = ''
  }
})
</script>

<style scoped>
.dlg { display: flex; flex-direction: column; gap: 12px; color: #e0e6ed }
.f-label { font-size: 12px; color: #94a3b8; white-space: nowrap }
.profile-bar, .name-row { display: flex; align-items: center; gap: 8px }
.profile-select { width: 200px }
.name-row .el-input { flex: 1 }
.metric-table { border: 1px solid #1e3a5f; border-radius: 6px; overflow: hidden }
.row { display: grid; grid-template-columns: 72px 84px 84px 1fr; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid #16293f }
.row:first-child, .row.head { border-top: none }
.row.head { background: #112233; font-size: 11px; color: #94a3b8 }
.row.invalid { background: #7f1d1d22 }
.col-m { font-size: 12px; display: flex; align-items: center; gap: 5px }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block }
.col-window { display: flex; align-items: center; gap: 4px }
.native-time {
  width: 96px; background: #0d1b2a; border: 1px solid #2a4a6f; border-radius: 4px;
  color: #e0e6ed; font-size: 12px; padding: 3px 4px; color-scheme: dark;
}
.dash { color: #64748b }
.err-text { color: #f87171; font-size: 11px; margin-top: 2px }
.indented { padding: 2px 8px 0 12px }
.rules-note { font-size: 11px; color: #64748b; line-height: 1.6; background: #11223366; padding: 6px 8px; border-radius: 4px }
.save-msg.ok { color: #4ade80; font-size: 12px }
</style>
