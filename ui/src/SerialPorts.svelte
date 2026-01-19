<script lang="ts">
  import Card from './lib/Card.svelte'
  import { address, connectionStatus } from 'api/src/vars'
  import { smallMode } from './Nodes.svelte'
  import axios from 'axios'
  import { hasAccess } from './lib/util'
  import { onMount } from 'svelte'

  interface SerialPortInfo {
    path: string
    displayName: string
    manufacturer?: string
    vendorId?: string
    productId?: string
  }

  let serialPorts: SerialPortInfo[] = []
  let loading = false
  let manualPort = ''

  async function refreshPorts() {
    loading = true
    try {
      const response = await axios.get('/serialPorts')
      serialPorts = response.data
    } catch (e) {
      console.error('Failed to fetch serial ports:', e)
      serialPorts = []
    }
    loading = false
  }

  function connectToPort(path: string) {
    $address = path
    axios.post('/connect', { address: path })
  }

  function connectManual() {
    if (manualPort.trim()) {
      connectToPort(manualPort.trim())
    }
  }

  onMount(() => {
    if ($hasAccess) {
      refreshPorts()
    }
  })
</script>

{#if $connectionStatus == 'disconnected' && $hasAccess}
  <Card title="Serial Ports" {...$$restProps}>
    <h2 slot="title" class="rounded-t flex items-center h-full gap-2">
      <div class="grow">Serial Ports</div>
      <button
        class="btn btn-sm h-6 px-2 text-xs"
        on:click={refreshPorts}
        disabled={loading}
        title="Refresh port list"
      >
        {loading ? '...' : '🔄'}
      </button>
    </h2>
    <div class="text-sm p-2 flex flex-col gap-1">
      {#if serialPorts.length == 0 && !loading}
        <p class="text-gray-400">
          No serial {#if $smallMode}<br />{/if}ports detected
        </p>
      {/if}
      {#if loading}
        <p class="text-gray-400">Scanning...</p>
      {/if}
      {#each serialPorts as port}
        <button
          class="btn text-left"
          on:click={() => connectToPort(port.path)}
          title={port.path}
        >
          <span class="font-mono text-xs opacity-70">{port.path}</span>
          <span class="ml-2">{port.displayName}</span>
        </button>
      {/each}

      <!-- Manual port entry -->
      <div class="mt-2 pt-2 border-t border-white/10">
        <form on:submit|preventDefault={connectManual} class="flex gap-1">
          <input
            type="text"
            class="input flex-1 text-xs"
            placeholder="COM3 or /dev/ttyUSB0"
            bind:value={manualPort}
          />
          <button type="submit" class="btn text-xs px-2" disabled={!manualPort.trim()}>
            Connect
          </button>
        </form>
      </div>
    </div>
  </Card>
{/if}
