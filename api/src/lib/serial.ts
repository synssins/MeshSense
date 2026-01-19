/**
 * Serial port enumeration and management for MeshSense
 * Provides safe port listing with sanitized device names
 */

import { SerialPort } from 'serialport'
import { State } from './state'

export interface SerialPortInfo {
  path: string;           // COM3, /dev/ttyUSB0, etc.
  displayName: string;    // Sanitized device name for UI display
  manufacturer?: string;  // Sanitized manufacturer name
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  pnpId?: string;
  friendlyName?: string;  // Sanitized friendly name from OS
}

/** State for tracking available serial ports */
export let serialPortList = new State<SerialPortInfo[]>('serialPortList', [], { primaryKey: 'path', hideLog: true })

/**
 * Sanitize device name for safe display
 * Removes/escapes potentially dangerous characters while preserving readability
 */
function sanitizeString(input: string | undefined): string {
  if (!input) return '';
  // Allow alphanumeric, spaces, hyphens, underscores, parentheses, periods
  // Strip or escape everything else
  return input
    .replace(/[<>"'`&;|$\\]/g, '')      // Remove dangerous chars
    .replace(/[\x00-\x1F\x7F]/g, '')    // Remove control chars
    .substring(0, 128)                   // Limit length
    .trim();
}

/**
 * Generate a display name from port info
 */
function generateDisplayName(port: Awaited<ReturnType<typeof SerialPort.list>>[0]): string {
  const manufacturer = sanitizeString(port.manufacturer);
  const friendlyName = sanitizeString(port.friendlyName);
  const pnpId = sanitizeString(port.pnpId);

  // Prefer friendlyName, then manufacturer, then pnpId
  if (friendlyName) {
    return friendlyName;
  }
  if (manufacturer) {
    return manufacturer;
  }
  if (pnpId) {
    // Extract meaningful part from PnP ID (e.g., "USB\\VID_10C4&PID_EA60" -> "USB Device")
    if (pnpId.includes('VID_10C4')) return 'Silicon Labs CP210x';
    if (pnpId.includes('VID_1A86')) return 'CH340/CH9102';
    if (pnpId.includes('VID_0403')) return 'FTDI Device';
    return 'Serial Device';
  }
  return 'Unknown Device';
}

/**
 * Check if a port path is likely a Meshtastic-compatible device
 * Based on common USB-Serial chip vendors
 */
function isMeshtasticLikelyDevice(port: Awaited<ReturnType<typeof SerialPort.list>>[0]): boolean {
  const vendorId = port.vendorId?.toLowerCase();
  const pnpId = port.pnpId?.toLowerCase() || '';

  // Silicon Labs CP210x (common in Heltec, TTGO, etc.)
  if (vendorId === '10c4' || pnpId.includes('vid_10c4')) return true;

  // WCH CH340/CH9102 (common in many ESP32 boards)
  if (vendorId === '1a86' || pnpId.includes('vid_1a86')) return true;

  // FTDI (used in some devices)
  if (vendorId === '0403' || pnpId.includes('vid_0403')) return true;

  // Espressif direct USB
  if (vendorId === '303a' || pnpId.includes('vid_303a')) return true;

  return false;
}

/**
 * List all available serial ports with sanitized information
 * Returns all ports but marks likely Meshtastic devices
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const ports = await SerialPort.list();

    const portInfoList: SerialPortInfo[] = ports.map(port => ({
      path: port.path,
      displayName: generateDisplayName(port),
      manufacturer: sanitizeString(port.manufacturer) || undefined,
      vendorId: port.vendorId,
      productId: port.productId,
      serialNumber: sanitizeString(port.serialNumber) || undefined,
      pnpId: sanitizeString(port.pnpId) || undefined,
      friendlyName: sanitizeString(port.friendlyName) || undefined
    }));

    // Sort: likely Meshtastic devices first, then alphabetically by path
    portInfoList.sort((a, b) => {
      const aLikely = ports.find(p => p.path === a.path);
      const bLikely = ports.find(p => p.path === b.path);
      const aIsMesh = aLikely ? isMeshtasticLikelyDevice(aLikely) : false;
      const bIsMesh = bLikely ? isMeshtasticLikelyDevice(bLikely) : false;

      if (aIsMesh && !bIsMesh) return -1;
      if (!aIsMesh && bIsMesh) return 1;
      return a.path.localeCompare(b.path);
    });

    // Update state
    serialPortList.set(portInfoList);

    console.log('[serial] Found ports:', portInfoList.map(p => `${p.path} (${p.displayName})`).join(', ') || 'none');

    return portInfoList;
  } catch (e) {
    console.error('[serial] Error listing ports:', e);
    return [];
  }
}

/**
 * Validate that a path looks like a valid serial port
 * Windows: COM1, COM2, etc.
 * Linux: /dev/ttyUSB0, /dev/ttyACM0, etc.
 * macOS: /dev/tty.usbserial-*, /dev/cu.usbmodem*, etc.
 */
export function isValidSerialPath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;

  // Windows COM ports
  if (/^COM\d+$/i.test(path)) return true;

  // Linux/macOS tty devices
  if (/^\/dev\/tty(USB|ACM|S)\d+$/.test(path)) return true;
  if (/^\/dev\/tty\.(usbserial|usbmodem|SLAB_USBtoUART|wchusbserial)[\w-]*$/i.test(path)) return true;
  if (/^\/dev\/cu\.(usbserial|usbmodem|SLAB_USBtoUART|wchusbserial)[\w-]*$/i.test(path)) return true;

  return false;
}

/**
 * Check if an address string represents a serial port path
 * Used to distinguish from MAC addresses and IP addresses
 */
export function isSerialPort(address: string): boolean {
  if (!address) return false;

  // Check Windows COM port pattern
  if (/^COM\d+$/i.test(address)) return true;

  // Check Unix-style paths
  if (address.startsWith('/dev/tty') || address.startsWith('/dev/cu.')) return true;

  return false;
}

/**
 * Get a specific port info by path
 */
export function getPortByPath(path: string): SerialPortInfo | undefined {
  return serialPortList.value.find(p => p.path === path);
}
