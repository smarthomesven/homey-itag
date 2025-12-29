'use strict';

const Homey = require('homey');

module.exports = class iTAGDevice extends Homey.Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('iTAG device has been initialized');
    this.log(`Homey version: ${this.homey.version}`);

    // Initialize ring capability only
    try {
      await this.setCapabilityValue('ring', false);
    } catch (error) {
      this.error('Error setting initial capability value:', error);
    }
    
    // Get Flow trigger cards
    this.deviceDisconnectedTrigger = this.homey.flow.getDeviceTriggerCard('device_disconnected');
    this.deviceReconnectedTrigger = this.homey.flow.getDeviceTriggerCard('device_reconnected');
    
    // Start RSSI monitoring interval only if not already running
    if (!this.rssiInterval) {
      this.startRSSIMonitoring();
    }
    
    // Only try notifications if Homey >= 6.0
    if (parseInt(this.homey.version, 10) < 6) {
      this.log('Homey version does not support BLE notifications');
      return;
    }
    
    // Initial connection attempt
    await this.connectToDevice();
  }

  async connectToDevice() {
    try {
      const address = this.getStoreValue('address');
      const uuid = address.replace(/:/g, '').toLowerCase();
      
      this.log('Finding iTAG device...');
      const advertisement = await this.homey.ble.find(uuid);
      
      // Update RSSI from advertisement
      await this.updateRSSI(advertisement.rssi);
      
      this.log('Connecting to iTAG device...');
      const peripheral = await advertisement.connect();
      this.log('Connected successfully');
      
      // Set connected status - only set to false when actually connected
      await this.setCapabilityValue('alarm_disconnected', false);
      
      // Trigger reconnected Flow if this was a reconnection
      if (this.wasDisconnected) {
        this.log('Triggering device_reconnected Flow');
        await this.deviceReconnectedTrigger.trigger(this, {}, {}).catch(err => {
          this.error('Error triggering reconnected Flow:', err);
        });
        this.wasDisconnected = false;
      }
      
      // Register the peripheral for notifications
      this.log('Registering peripheral for notifications...');
      this.homey.ble.__registerPeripheral(peripheral);
      this.log('Peripheral registered');
      
      // Discover all services first
      this.log('Discovering all services...');
      const services = await peripheral.discoverServices();
      this.log('Discovered', services.length, 'services');
      
      // Find the FFE0 service from the discovered services
      const service = await peripheral.getService('0000ffe000001000800000805f9b34fb');
      if (!service) {
        throw new Error('FFE0 service not found');
      }
      const alertService = await peripheral.getService('0000180200001000800000805f9b34fb');
      this.log('Found FFE0 service, ID:', service.id);
      
      // WORKAROUND: If service.id is undefined, manually set it to the UUID
      if (!service.id) {
        this.log('WARNING: service.id is undefined, manually setting it');
        service.id = service.uuid;
      }
      
      // Find the characteristics we need
      const linkLostChar = await service.getCharacteristic('0000ffe200001000800000805f9b34fb');
      const buttonChar = await service.getCharacteristic('0000ffe100001000800000805f9b34fb');
      const alertChar = await alertService.getCharacteristic('00002a0600001000800000805f9b34fb');
      
      if (!linkLostChar) {
        throw new Error('LinkLost characteristic (FFE2) not found');
      }
      if (!buttonChar) {
        throw new Error('Button characteristic (FFE1) not found');
      }
      if (!alertChar) {
        throw new Error('Alert characteristic (2A06) not found');
      }
      
      // WORKAROUND: Set IDs for characteristics if they're undefined
      if (!linkLostChar.id) {
        linkLostChar.id = linkLostChar.uuid;
      }
      if (!buttonChar.id) {
        buttonChar.id = buttonChar.uuid;
      }
      if (!alertChar.id) {
        alertChar.id = alertChar.uuid;
      }

      this.alertChar = alertChar;
      
      this.log('Found all characteristics');
      
      // Write to LinkLost characteristic to disable alarm
      this.log('Writing to LinkLost characteristic to disable alarm...');
      await linkLostChar.write(Buffer.from([0x00]));
      this.log('Successfully disabled LinkLost alarm');
      
      // Store the peripheral for later use
      this.peripheral = peripheral;
      
      // Listen for disconnects
      peripheral.once('disconnect', () => {
        this.log('iTAG device disconnected');
        
        // Set disconnected status
        this.setCapabilityValue('alarm_disconnected', true).catch(err => {
          this.error('Error setting disconnected alarm:', err);
        });
        
        // Mark as disconnected for reconnection Flow trigger
        this.wasDisconnected = true;
        
        // Trigger disconnected Flow
        this.deviceDisconnectedTrigger.trigger(this, {}, {}).catch(err => {
          this.error('Error triggering disconnected Flow:', err);
        });
        
        // Unregister the peripheral
        this.homey.ble.__unregisterPeripheral(peripheral);
        this.peripheral = null;
        this.reconnect();
      });

      // Register capability listener only once
      if (!this.ringListenerRegistered) {
        this.registerCapabilityListener('ring', async (value) => {
          await this.ringDevice(value);
          if (value === true) {
            this._ringTimeout = await this.homey.setTimeout(async () => {
              await this.ringDevice(false);
              await this.setCapabilityValue('ring', false);
            }, 10000); // Ring for 10 seconds
          } else {
            if (this._ringTimeout) {
              this.homey.clearTimeout(this._ringTimeout);
              this._ringTimeout = null;
            }
          }
          return true;
        });
        this.ringListenerRegistered = true;
      }

      const startRingingAction = this.homey.flow.getActionCard('start_ringing');
      const stopRingingAction = this.homey.flow.getActionCard('stop_ringing');

      // Register Flow action listeners only once
      if (!this.flowActionsRegistered) {
        startRingingAction.registerRunListener(async (args, state) => {
          this.log('Flow action: Start Ringing');
          await this.ringDevice(true);
          await this.setCapabilityValue('ring', true);
          this._ringTimeout = await this.homey.setTimeout(async () => {
            await this.ringDevice(false);
            await this.setCapabilityValue('ring', false);
          }, 10000); // Ring for 10 seconds
          return true;
        });

        stopRingingAction.registerRunListener(async (args, state) => {
          this.log('Flow action: Stop Ringing');
          await this.ringDevice(false);
          if (this._ringTimeout) {
            this.homey.clearTimeout(this._ringTimeout);
            this._ringTimeout = null;
          }
          await this.setCapabilityValue('ring', false);
          return true;
        });

        this.flowActionsRegistered = true;
      }
      
    } catch (error) {
      this.log('Error connecting to iTAG device:', error);
      this.log('Error message:', error.message);
      this.log('Error stack:', error.stack);
      
      // Set disconnected status
      await this.setCapabilityValue('alarm_disconnected', true).catch(err => {
        this.error('Error setting disconnected alarm:', err);
      });
      
      // Mark as disconnected for reconnection Flow trigger
      this.wasDisconnected = true;
      
      // Try to reconnect after a delay
      this.reconnect();
    }
  }
  async ringDevice(value) {
    this.log('Capability "ring" changed to:', value); 
    if (value === true) {
      this.log('Ringing iTAG device...');
      try {
        await this.alertChar.write(Buffer.from([0x02]));
        this.log('iTAG device rung successfully');
      } catch (error) {
        this.error('Error ringing iTAG device:', error);
      }
    } else {
      this.log('Stopping ring on iTAG device...');
      try {
        await this.alertChar.write(Buffer.from([0x00]));
        this.log('iTAG device ring stopped successfully');
      } catch (error) {
        this.error('Error stopping ring on iTAG device:', error);
      }
    }
  }

  startRSSIMonitoring() {
    this.log('Starting RSSI monitoring');
    
    // Monitor RSSI every 30 seconds
    this.rssiInterval = this.homey.setInterval(async () => {
      try {
        // If we have an active peripheral connection, use its updateRssi method
        if (this.peripheral) {
          const rssi = await this.peripheral.updateRssi();
          await this.updateRSSI(rssi);
        } else {
          // If not connected, try to find the device via discovery to get RSSI
          const address = this.getStoreValue('address');
          const uuid = address.replace(/:/g, '').toLowerCase();
          
          const advertisements = await this.homey.ble.discover();
          const advertisement = advertisements.find(ad => ad.uuid === uuid);
          
          if (advertisement && advertisement.rssi !== undefined) {
            await this.updateRSSI(advertisement.rssi);
          } else {
            this.log('Device not found in BLE scan - may be out of range');
          }
        }
      } catch (error) {
        this.error('Error updating RSSI:', error);
      }
    }, 5000); // Update every 5 seconds
  }

  async updateRSSI(rssi) {
    if (rssi !== undefined && rssi !== null) {
      this.log('Updating RSSI to:', rssi);
      try {
        await this.setCapabilityValue('measure_signal_strength', rssi);
      } catch (error) {
        this.error('Error setting RSSI capability:', error);
      }
    }
  }

  async reconnect() {
    this.log('Attempting to reconnect...');
    // Don't reset alarm here - keep it as disconnected until we actually reconnect
    this.reconnectTimeout = this.homey.setTimeout(async () => {
      await this.connectToDevice();
    }, 7000);
  }

  async onAdded() {
    this.log('iTAG device has been added');
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('iTAG device settings were changed');
  }

  async onRenamed(name) {
    this.log('iTAG device was renamed');
  }

  async onDeleted() {
    this.log('iTAG device has been deleted');
    
    // Clear intervals and timeouts
    if (this.rssiInterval) {
      this.homey.clearInterval(this.rssiInterval);
    }
    
    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
    }
    
    if (this.ringTimeout) {
      this.homey.clearTimeout(this.ringTimeout);
    }
    
    if (this.peripheral) {
      try {
        this.homey.ble.__unregisterPeripheral(this.peripheral);
        await this.peripheral.disconnect();
      } catch (error) {
        this.log('Error disconnecting:', error);
      }
    }
  }

};