/**
 * Node.js Serial Connection for Meshtastic devices
 * Provides serial connectivity using the serialport npm package
 */

import { SerialPort } from 'serialport'
import { MeshDevice, Types } from '../../meshtastic-js/dist'

/** Meshtastic serial framing constants */
const SERIAL_MAGIC_BYTE1 = 0x94;
const SERIAL_MAGIC_BYTE2 = 0xc3;

export interface NodeSerialConnectionParameters {
  path: string;
  baudRate?: number;
  concurrentLogOutput?: boolean;
}

/**
 * Node.js Serial Connection for Meshtastic devices
 * Implements the MeshDevice interface for serial communication
 */
export class NodeSerialConnection extends MeshDevice {
  public connType: Types.ConnectionTypeName = 'serial';
  protected portId: string = '';

  private port: SerialPort | null = null;
  private path: string = '';
  private baudRate: number = 115200;
  private receiveBuffer: Buffer = Buffer.alloc(0);
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private disconnectPending: boolean = false;
  private intentionalDisconnect: boolean = false;

  constructor(configId?: number) {
    super(configId);
    console.log('[NodeSerialConnection] Instantiated');
  }

  /**
   * Connect to a Meshtastic device via serial port
   * @param params - Node serial connection parameters (path and optional baudRate)
   */
  public async connect(params: NodeSerialConnectionParameters | Types.ConnectionParameters): Promise<void> {
    const nodeParams = params as NodeSerialConnectionParameters;
    const { path, baudRate = 115200 } = nodeParams;

    this.path = path;
    this.baudRate = baudRate;
    this.portId = path;
    this.intentionalDisconnect = false;
    this.disconnectPending = false;

    console.log(`[NodeSerialConnection] Connecting to ${path} at ${baudRate} baud`);
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnecting);

    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path,
        baudRate,
        autoOpen: false
      });

      this.port.on('error', (err) => {
        console.error('[NodeSerialConnection] Port error:', err.message);
        // Only trigger disconnect if the port is actually closed and we haven't already started disconnecting
        if (!this.disconnectPending && !this.port?.isOpen) {
          this.handleUnexpectedDisconnect();
        }
      });

      this.port.on('close', () => {
        console.log('[NodeSerialConnection] Port closed event received');
        // Only trigger disconnect if this wasn't an intentional disconnect and we haven't already started
        if (!this.intentionalDisconnect && !this.disconnectPending) {
          this.handleUnexpectedDisconnect();
        }
      });

      this.port.on('data', (data: Buffer) => {
        this.handleIncomingData(data);
      });

      this.port.open((err) => {
        if (err) {
          console.error('[NodeSerialConnection] Failed to open port:', err.message);
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
          reject(err);
          return;
        }

        console.log('[NodeSerialConnection] Port opened successfully');
        this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);

        // Start heartbeat interval (required for serial connection)
        this.startHeartbeat();

        // Configure the device
        this.configure().catch((e) => {
          console.warn('[NodeSerialConnection] Configure error (may be normal):', e);
        });

        resolve();
      });
    });
  }

  /**
   * Disconnect from the serial port
   */
  public async disconnect(): Promise<void> {
    console.log('[NodeSerialConnection] Disconnecting (intentional)');
    this.intentionalDisconnect = true;
    this.disconnectPending = true;
    this.stopHeartbeat();

    return new Promise((resolve) => {
      if (this.port && this.port.isOpen) {
        this.port.close((err) => {
          if (err) {
            console.error('[NodeSerialConnection] Error closing port:', err.message);
          }
          this.port = null;
          this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
          this.complete();
          this.disconnectPending = false;
          resolve();
        });
      } else {
        this.port = null;
        this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
        this.complete();
        this.disconnectPending = false;
        resolve();
      }
    });
  }

  /**
   * Handle unexpected disconnection with debouncing
   * This helps filter out spurious disconnect events from USB device changes
   */
  private handleUnexpectedDisconnect(): void {
    if (this.disconnectPending) return;
    this.disconnectPending = true;

    // Add a brief delay to filter out spurious events
    setTimeout(() => {
      // Double-check that the port is actually closed
      if (!this.port?.isOpen) {
        console.log('[NodeSerialConnection] Confirmed port disconnection');
        this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
        this.stopHeartbeat();
        this.complete();
      } else {
        console.log('[NodeSerialConnection] Port still open, ignoring spurious disconnect event');
        this.disconnectPending = false;
      }
    }, 100);
  }

  /**
   * Check if connection is alive
   */
  public async ping(): Promise<boolean> {
    return this.port?.isOpen ?? false;
  }

  /**
   * Reconnect to the device
   */
  public async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect({ path: this.path, baudRate: this.baudRate });
  }

  /**
   * Write data to the radio using Meshtastic framing protocol
   */
  protected async writeToRadio(data: Uint8Array): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      throw new Error('Serial port not open');
    }

    // Meshtastic serial framing: [0x94, 0xc3, 0x00, length, ...data]
    const frame = Buffer.alloc(4 + data.length);
    frame[0] = SERIAL_MAGIC_BYTE1;
    frame[1] = SERIAL_MAGIC_BYTE2;
    frame[2] = 0x00;
    frame[3] = data.length;
    Buffer.from(data).copy(frame, 4);

    return new Promise((resolve, reject) => {
      this.port!.write(frame, (err) => {
        if (err) {
          console.error('[NodeSerialConnection] Write error:', err.message);
          reject(err);
          return;
        }
        this.port!.drain((drainErr) => {
          if (drainErr) {
            console.error('[NodeSerialConnection] Drain error:', drainErr.message);
          }
          resolve();
        });
      });
    });
  }

  /**
   * Handle incoming serial data and parse Meshtastic frames
   */
  private handleIncomingData(data: Buffer): void {
    // Append new data to buffer
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // Process complete frames
    while (this.receiveBuffer.length >= 4) {
      // Look for magic bytes
      const magicIndex = this.findMagicBytes();
      if (magicIndex === -1) {
        // No magic bytes found, clear buffer except last byte (might be partial magic)
        if (this.receiveBuffer.length > 1) {
          this.receiveBuffer = this.receiveBuffer.slice(-1);
        }
        break;
      }

      // Discard any data before magic bytes
      if (magicIndex > 0) {
        this.receiveBuffer = this.receiveBuffer.slice(magicIndex);
      }

      // Check if we have enough data for header
      if (this.receiveBuffer.length < 4) {
        break;
      }

      // Parse frame header
      const msb = this.receiveBuffer[2];
      const lsb = this.receiveBuffer[3];
      const payloadLength = (msb << 8) | lsb;

      // Check if we have complete frame
      if (this.receiveBuffer.length < 4 + payloadLength) {
        break;
      }

      // Extract payload
      const payload = this.receiveBuffer.slice(4, 4 + payloadLength);

      // Remove processed frame from buffer
      this.receiveBuffer = this.receiveBuffer.slice(4 + payloadLength);

      // Process the payload
      try {
        this.handleFromRadio(new Uint8Array(payload));
      } catch (e) {
        console.error('[NodeSerialConnection] Error handling packet:', e);
      }
    }

    // Prevent buffer from growing too large
    if (this.receiveBuffer.length > 4096) {
      console.warn('[NodeSerialConnection] Buffer overflow, clearing');
      this.receiveBuffer = Buffer.alloc(0);
    }
  }

  /**
   * Find the magic byte sequence in the receive buffer
   */
  private findMagicBytes(): number {
    for (let i = 0; i < this.receiveBuffer.length - 1; i++) {
      if (this.receiveBuffer[i] === SERIAL_MAGIC_BYTE1 &&
          this.receiveBuffer[i + 1] === SERIAL_MAGIC_BYTE2) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Start heartbeat interval to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Send heartbeat every 60 seconds (firmware requires at least one per 15 minutes)
    this.heartbeatInterval = setInterval(() => {
      this.heartbeat().catch((err) => {
        console.error('[NodeSerialConnection] Heartbeat error:', err);
      });
    }, 60 * 1000);
  }

  /**
   * Stop heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Get current port path
   */
  public getPath(): string {
    return this.path;
  }

  /**
   * Check if port is open
   */
  public isConnected(): boolean {
    return this.port?.isOpen ?? false;
  }
}
